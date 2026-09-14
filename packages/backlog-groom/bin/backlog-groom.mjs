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
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { groom } from '../lib/groom.mjs';
import { renderReport } from '../lib/report.mjs';
import { renderUsage, parseOptions, validateThreshold, validateApplyArgs, describeError } from '../lib/usage.mjs';
import { loadProfile, loadCache, saveCache, serialiseJson, baseFloorFromGit } from '../lib/io.mjs';
import { applyRun } from '../lib/apply.mjs';
import { makeReviewRunner, reviewerPair } from '../lib/gate.mjs';

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

  const ledgerPath = values.ledger ?? '.adlc/backlog-groom-ledger.json';
  const ledger = loadCache(ledgerPath);

  // Read the floor as it exists at the MERGE BASE. Null means unreadable, and
  // the floor guard refuses to act on an unknown base rather than assuming one.
  const baseFloor = baseFloorFromGit(profilePath, { baseRef: values['base-ref'] });

  const pair = reviewerPair(profile);
  if (!pair.ok) console.error(`backlog-groom: ${pair.reason} — every action will demote to a proposal`);

  const runReview = makeReviewRunner({ spawn: spawnSync, artifactPath: values.set, reviewer: pair.reviewer });

  let applied;
  try {
    applied = applyRun({
      set,
      profile,
      baseFloor,
      ledger,
      runReview,
      gh: ghWriter(),
      floorWideningAuthorized: values['authorize-floor-widening'],
    });
  } catch (err) {
    opError(describeError(err, 'apply failed'));
  }

  const warn = saveCache(ledgerPath, ledger);
  if (warn) console.error(`backlog-groom: warning — ${warn}`);

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

/**
 * The GitHub writer. Every mutation the tool performs goes through exactly these
 * three calls, so there is one place to audit and one place to stub.
 */
function ghWriter() {
  const gh = (args, input) => {
    const res = spawnSync('gh', args, { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
    if (res.error || res.status !== 0) throw new Error(res.stderr?.trim() || res.error?.message || `gh ${args[0]} failed`);
    return res.stdout;
  };
  return {
    comments: (number) => {
      const raw = gh(['issue', 'view', String(number), '--json', 'comments']);
      return (JSON.parse(raw).comments ?? []).map((c) => c.body ?? '');
    },
    comment: (number, body) => gh(['issue', 'comment', String(number), '--body-file', '-'], body),
    apply: (number, action) => {
      if (action === 'close') return gh(['issue', 'close', String(number)]);
      throw new Error(`no writer wired for action ${action}`);
    },
  };
}
