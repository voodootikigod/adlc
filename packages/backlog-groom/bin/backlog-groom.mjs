#!/usr/bin/env node
/**
 * backlog-groom — the read path.
 *
 * Grooms a GitHub issue backlog against the code and emits a ranked, clustered,
 * premise-verified set. This half WRITES NOTHING: the gate, the autonomy floor
 * and execution live in the write path, and proposals are emitted for it rather
 * than applied here.
 *
 * Exit codes follow the toolkit convention: 0 = ran, 1 = operational error.
 * There is no gate-fail exit, because a read-only sweep has no verdict to fail.
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import { groom } from '../lib/groom.mjs';
import { headCommit } from '../lib/verify.mjs';
import { renderReport } from '../lib/report.mjs';
import { renderUsage, parseOptions, validateThreshold, validateApplyArgs, describeError } from '../lib/usage.mjs';
import { loadProfile, loadCache, saveCache, serialiseJson, baseProfileFromGit, loadLedger, saveLedger, acquireApplyLock } from '../lib/io.mjs';
import { applyRun } from '../lib/apply.mjs';
import { makeGhWriter } from '../lib/gh.mjs';
import { makeReviewRunner, reviewerPair, buildActionArtifact, artifactName } from '../lib/gate.mjs';

/**
 * The operational-error exit code, named once and used by BOTH exit paths.
 *
 * Two literals would drift: an unexpected failure and a reported one would
 * eventually disagree about what a caller sees, and only one of them has a test
 * reaching it.
 */
const EXIT_OPERATIONAL = 1;

process.on('uncaughtException', (err) => {
  // An opError has already printed its message and set the exit code; a stack
  // trace on top of it is noise the operator has to read past.
  if (err?.handled) return;
  console.error(`backlog-groom: ${err?.stack ?? err}`);
  process.exitCode = EXIT_OPERATIONAL;
});

const USAGE = renderUsage();


/**
 * Report an operational error and stop.
 *
 * `process.exitCode` plus a thrown sentinel rather than `process.exit`: an
 * explicit exit can terminate the process while stdout is still draining, which
 * truncates a piped payload. Nothing here is large, but the rule is uniform so
 * the dangerous case below cannot be the exception nobody noticed.
 */
function opError(message) {
  console.error(`backlog-groom: ${message}`);
  process.exitCode = EXIT_OPERATIONAL;
  throw Object.assign(new Error(message), { handled: true });
}

let values;
try {
  ({ values } = parseArgs({ options: parseOptions() }));
} catch (err) {
  opError(err.message);
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

let threshold;
try {
  threshold = validateThreshold(values.threshold);
} catch (err) {
  opError(err.message);
}

const profilePath = values.profile ?? '.claude/backlog-groom-profile.json';
let profile;
try {
  profile = loadProfile(profilePath);
} catch (err) {
  opError(describeError(err, `could not read ${profilePath}`));
}

const cachePath = values.cache ?? '.adlc/backlog-groom-cache.json';
const cache = values['no-cache'] ? null : loadCache(cachePath);

// ---- --apply: the write path (§3.6-§3.8) -----------------------------------
//
// Deliberately a separate branch rather than a flag threaded through the read
// run: the read path must stay reachable with no possibility of a write, so the
// two never share a code path that a flag could flip.
if (values.apply) {
  const applyArgError = validateApplyArgs(values);
  if (applyArgError) opError(applyArgError);

  let set;
  try {
    set = JSON.parse(readFileSync(values.set, 'utf8'));
  } catch (err) {
    opError(`could not read ${values.set}: ${err.message}`);
  }

  // FIXED, not caller-chosen. A ledger path the caller picks is a one-shot rule
  // the caller can reset: point at a fresh file and every spent review is
  // forgotten. Same reasoning as the floor's comparison ref.
  const ledgerPath = '.adlc/backlog-groom-ledger.json';

  // The ledger's directory may not exist on a repo that has not adopted ADLC,
  // and the documented --apply command should work there rather than failing on
  // a missing parent.
  const ledgerDir = dirname(ledgerPath);
  try { if (!existsSync(ledgerDir)) mkdirSync(ledgerDir); } catch { /* the lock will report it */ }

  // LOCK FIRST, then read. Loading the ledger before taking the lock is a
  // read-then-lock race: two runs can both read a ledger with no entry for a
  // revision, then serialise on the lock and each act on the stale copy it
  // already holds.
  let releaseLock;
  try {
    releaseLock = acquireApplyLock(`${ledgerPath}.lock`);
  } catch (err) {
    opError(describeError(err, 'could not take the apply lock'));
  }

  let ledger;
  try {
    ledger = loadLedger(ledgerPath);
  } catch (err) {
    releaseLock();
    opError(describeError(err, 'could not load the gate ledger'));
  }

  // Read the floor as it exists at the MERGE BASE. Null means unreadable, and
  // the floor guard refuses to act on an unknown base rather than assuming one.
  // No caller-chosen ref: resolveTrustedBaseRef reads it from the repository.
  const baseProfile = baseProfileFromGit(profilePath);
  const baseFloor = baseProfile ? baseProfile.autonomyFloor : null;
  const baseFrozenPaths = baseProfile ? (baseProfile.frozenPaths ?? []) : null;

  const pair = reviewerPair(profile);
  if (!pair.ok) console.error(`backlog-groom: ${pair.reason} — every action will demote to a proposal`);

  // ONE artifact per action, written to a scratch file the reviewer reads. The
  // whole-set artifact would return one verdict for the batch, which is not
  // attributable to the specific write being executed.
  const artifactDir = mkdtempSync(join(tmpdir(), 'backlog-groom-'));
  // Releasing the lock and clearing the scratch directory, together, so no exit
  // path can do one and forget the other. The artifact directory left behind
  // leaks one git-sized directory per run until the filesystem runs out of
  // INODES — which reports as "no space left on device" while df still shows
  // plenty of free bytes, and is a genuinely confusing afternoon.
  const cleanup = () => {
    try { releaseLock(); } catch { /* releasing must never mask the run's own error */ }
    try { rmSync(artifactDir, { recursive: true, force: true }); } catch { /* scratch */ }
  };
  const runReview = (action) =>
    makeReviewRunner({
      spawn: spawnSync,
      artifactPath: writeArtifact(artifactDir, action),
      reviewer: pair.reviewer,
    })();

  const ghIo = makeGhWriter({ spawn: spawnSync });

  let applied;
  try {
    applied = applyRun({
      set,
      profile,
      baseFloor,
      baseFrozenPaths,
      ledger,
      runReview,
      gh: ghIo,
      // Re-derive the set's security-relevant claims from the live issue and the
      // repository, rather than trusting a JSON file any caller can edit.
      fetchIssue: (n) => ghIo.issue(n),
      // Our own login, so only our own prior marker counts as the evidence trail.
      self: (() => { try { return ghIo.login(); } catch { return null; } })(),
      // The set describes one revision; acting on it at another closes issues on
      // evidence that no longer describes the code.
      revision: headCommit(),
      // Checkpointed after every gate decision, before any write.
      persist: (l) => saveLedger(ledgerPath, l),
    });
  } catch (err) {
    // ONE cleanup path, reached by success and failure alike. Two of them drift:
    // the failure branch was already the one that forgot the artifact directory,
    // which is precisely the run that has been going long enough to have written
    // some, and a scheduled sweep that fails repeatedly leaks fastest.
    cleanup();
    opError(describeError(err, 'apply failed'));
  }

  try {
    saveLedger(ledgerPath, ledger);
  } finally {
    cleanup();
  }

  console.log(serialiseJson(applied).trimEnd());
  process.exitCode = 0;
} else {

// No `judge` is wired here. Relation judgment is a model call the SKILL supplies
// (§3.4); the CLI alone surfaces candidates and reports what the filter excluded,
// so a bare CLI run never emits a relation it did not have judgment for.
const result = groom({ profile, cache, io: {}, relationThreshold: threshold });

if (!result.ok) opError(result.unconsultable);

const cacheWarning = saveCache(cachePath, cache);
if (cacheWarning) console.error(`backlog-groom: warning — ${cacheWarning}`);

if (values.out) {
  try {
    writeFileSync(values.out, serialiseJson(result.set));
  } catch (err) {
    opError(`could not write ${values.out}: ${err.message}`);
  }
}

// NO `process.exit(0)` HERE. `console.log` to a PIPE is asynchronous, and a
// 500-issue groomed set comfortably exceeds the pipe buffer; forcing exit
// terminates the process before stdout drains and the consumer receives a
// truncated, unparseable payload. Setting the code and letting the event loop
// finish is what guarantees the whole document arrives.
if (values.json) console.log(serialiseJson(result.set).trimEnd());
else console.log(renderReport(result.set));

process.exitCode = 0;
}

/** Write one action's review artifact and return its path. */
function writeArtifact(dir, action) {
  const path = join(dir, artifactName(action));
  writeFileSync(path, `${buildActionArtifact(action)}\n`);
  return path;
}
