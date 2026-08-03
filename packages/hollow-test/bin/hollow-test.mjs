#!/usr/bin/env node
// hollow-test — diff-scoped mutation gate (ADLC C4)
// Refuses to run on a dirty working tree. Mutates files in place and restores
// them via finally blocks, a handler for every catchable termination signal, and
// an on-disk in-flight record that the NEXT run recovers from when the kill was
// not catchable at all.

import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { parseArgs, pass, gateFail, opError, printJson } from '@adlc/core';
import { gitDiff, isDirty, isGitRepo, resolveBase, mutate, git, repoRoot } from '@adlc/core';
import {
  filterTargetFiles, buildFileTargets, readFileSafe,
  readRailsFromTicketFile, expandRailsToFiles, isMutableSource, isSupportedSourceExtension,
} from '../lib/targets.mjs';
import { runMutant, runTest } from '../lib/runner.mjs';
import {
  ownerStateFor, isWellFormed, decideRecovery, writeRecord, readRecord, clearRecord,
  resolveTarget, recordPathFor, writeFileAtomic, sweepStaleTemps,
} from '../lib/inflight.mjs';
import { printTable, buildJsonReport } from '../lib/report.mjs';

// ── arg parsing ─────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    'test-cmd':   { type: 'string' },
    base:         { type: 'string' },
    max:          { type: 'string', default: '20' },
    'timeout-ms': { type: 'string', default: '120000' },
    target:       { type: 'string', multiple: true },
    rails:        { type: 'string', multiple: true },
    // Extra globs to treat as tests, for projects whose convention this tool
    // cannot infer. The built-in rules cover directory segments and the dotted,
    // exact and snake basename forms; HYPHENATED names (foo-test.js, spec-foo.js)
    // are deliberately excluded from the defaults because a hyphen cannot
    // distinguish a test convention from a product name — `hollow-test.mjs` and
    // `spec-lint.mjs` are production files in this very repo. Rather than guess,
    // let a caller whose project uses that convention declare it:
    //   --test-glob '**/*-test.js'
    'test-glob':  { type: 'string', multiple: true },
    'source-glob':{ type: 'string', multiple: true },
    json:         { type: 'boolean', default: false },
    help:         { type: 'boolean', default: false },
  },
});

if (values.help || !values['test-cmd']) {
  console.log(`
hollow-test — diff-scoped mutation gate (ADLC C4)

Usage:
  hollow-test --test-cmd "node --test test/" [options]

Options:
  --test-cmd <cmd>      (required) Shell command to run the test suite
  --base <ref>          Git base ref for diff (default: merge-base with
                        main/master; fails closed if none can be resolved)
  --max <n>             Max mutants across all files (default: 20)
  --timeout-ms <n>      Test command timeout in ms (default: 120000)
  --target <file>       Mutate this file directly, independent of the diff
                        (repeatable; bypasses the test/spec path exclusion).
                        Use for characterization/rails-authoring tickets
                        where the behavior file isn't in the diff. Must
                        resolve inside the repository root; paths that
                        escape it (e.g. via ../../) are refused.
  --rails <ticket-file> Path to a ticket JSON file; its declared "rails"
                        globs are expanded against tracked files and added
                        as mutation targets (repeatable).
  --json                Machine-readable JSON output
  --help                Show this help

Exit codes:
  0  All mutants killed (gate passes)
  1  Operational error (dirty tree, not a git repo, bad args, nothing to mutate,
     the in-flight record could not be written)
  2  One or more mutants survived (hollow coverage)
`);
  process.exit(values.help ? 0 : 1);
}

const testCmd   = values['test-cmd'];
const testGlobs = values['test-glob'] ?? [];
// Rescues production files whose names match a test convention — `hollow-test.mjs`,
// `spec-lint.mjs`. Convention alone cannot resolve that ambiguity; the project must.
const sourceGlobs = values['source-glob'] ?? [];
const maxMutants = parseInt(values.max, 10);
const timeoutMs  = parseInt(values['timeout-ms'], 10);
const useJson    = values.json;
const cwd        = process.cwd();

if (isNaN(maxMutants) || maxMutants < 1) opError('--max must be a positive integer');
if (isNaN(timeoutMs) || timeoutMs < 1)   opError('--timeout-ms must be a positive integer');

// ── safety checks ───────────────────────────────────────────────────────────

if (!isGitRepo(cwd)) {
  opError('not a git repository');
}

// ── repo root ───────────────────────────────────────────────────────────────
// Resolved BEFORE recovery, because recovery has to re-derive its write target
// against the repository rather than trust a path out of a file.
//
// Repo root is NOT necessarily `cwd`: hollow-test may be invoked from any
// subdirectory (e.g. a per-package script that `cd`s into packages/foo/ first),
// so anything reasoning about the repo as a whole (rails-glob matching,
// --target containment) must resolve against this.
let root;
try {
  root = repoRoot(cwd);
} catch (err) {
  opError(`could not resolve repository root: ${err.message}`);
}

// FAIL CLOSED if the git dir cannot be derived. Treating this as "no record" let
// the run mutate with no way back and still exit 0 — the opposite of the
// guarantee, and silent. We already know this is a git repo, so a failure here is
// an anomaly worth stopping for, not a condition to route around.
let gitDir;
try {
  gitDir = resolve(cwd, git(['rev-parse', '--git-dir'], { cwd }).trim());
} catch (err) {
  opError(`could not resolve the git directory (${err.message}) — refusing to mutate without a recovery record`);
}
if (!existsSync(gitDir)) {
  opError(`the resolved git directory does not exist (${gitDir}) — refusing to mutate without a recovery record`);
}

// ── recover a mutant stranded by an interrupted run ─────────────────────────
//
// MUST run before the dirty-tree refusal below, because the dirt is very often
// OUR OWN. Every in-process restore path dies with the process, so a SIGKILL, an
// OOM kill or a tool/CI timeout mid-trial leaves a live mutant in the working
// tree as an unstaged edit. (Process death, NOT power loss: the page cache
// survives a killed process, so no fsync is needed or claimed — see
// writeFileAtomic.) The next run then refuses with "commit or stash first", which
// reads as if the USER's work is in the way; the reflex is to commit it, and that
// is how a mutant ships. Observed for real: a tool timeout stranded `? 130 :`
// flipped to `? 131 :`, and an `authorized = false` -> `true` flip before that.
//
// The record lives in the git dir: never committed, and per-worktree
// (`--git-dir` resolves to .git/worktrees/<name> in a linked worktree), so
// parallel worktrees cannot recover each other's files.
const inflightPath = recordPathFor(gitDir);

function clearInflight() {
  if (inflightPath !== null) clearRecord(inflightPath);
}

/**
 * Restore a file left mutated by a dead run — but ONLY when we can prove that is
 * what it is.
 *
 * The proof is byte equality with the mutant we recorded. Restoring merely
 * because the file differs from the original would overwrite whatever the
 * developer did to it after the crash, which is the same data loss this feature
 * exists to prevent, pointed the other way.
 *
 * @returns {{file: string, pid: number|null} | null}
 */
function recoverInflight() {
  if (inflightPath === null) return null;
  const record = readRecord(inflightPath);
  if (record === null) return null;
  if (!isWellFormed(record)) {
    clearInflight();
    return null;
  }

  const target = resolveTarget(root, record.file);
  if (target === null) {
    // Escapes the repo, is symlinked, or names something absent. Never write it;
    // never silently drop it either — a human should see this.
    console.warn(
      `hollow-test: ignoring an in-flight record naming ${record.file}, which does ` +
      'not resolve to a regular file inside this repository'
    );
    return null;
  }

  // A SIGKILL between creating a temp and renaming it leaves an untracked
  // orphan, and the dirty-tree check would then refuse every future run.
  sweepStaleTemps(target);

  let current;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    return null;
  }

  const ownerState = ownerStateFor(record.pid, process.pid);
  const decision = decideRecovery({ ownerState, currentContent: current, record });

  if (decision.action === 'none') {
    clearInflight();
    return null;
  }
  if (decision.action === 'skip') {
    console.warn(
      `hollow-test: leaving ${record.file} alone — ${decision.reason}. If the tree is ` +
      'dirty, that edit may be a mutant rather than your work'
    );
    return null;
  }
  if (decision.action === 'conflict') {
    // STOP. Keeping the record is not enough on its own: if the run continued, the
    // next mutation would overwrite this record and then clear it, destroying the
    // only surviving copy of the original bytes — the exact loss the conflict
    // branch exists to prevent. Resolving this needs a human.
    opError(
      `${record.file} ${decision.reason}, so it was not restored. A previous run was ` +
      `interrupted while mutating it, and the file has changed since. The original ` +
      `bytes are preserved in ${inflightPath}: compare them with the file, keep ` +
      `whichever is correct, then delete that record to continue.`
    );
  }

  try {
    writeFileAtomic(target, record.original);
  } catch (err) {
    // Never clear a record whose restore failed — it is the only copy left.
    opError(
      `could not restore ${record.file} from the in-flight record: ${err.message}. ` +
      `The original bytes are preserved in ${inflightPath}`
    );
  }
  clearInflight();
  return { file: record.file, pid: record.pid ?? null };
}

const recoveredInflight = recoverInflight();
if (recoveredInflight !== null && !useJson) {
  console.warn(
    `hollow-test: restored ${recoveredInflight.file} from an interrupted run ` +
    `(pid ${recoveredInflight.pid}) — that edit was a mutant, not your work`,
  );
}

if (isDirty(cwd)) {
  opError('commit or stash first — hollow-test mutates files in place and restores them');
}

// Symlink-free real path of the repo root, used by symlinkEscapesRoot() below.
// `repoRoot()` itself already runs `git rev-parse --show-toplevel`, which
// resolves symlinks in its own path components, so this should normally
// equal `root` — but resolve it independently rather than assume that.
let rootReal;
try {
  rootReal = realpathSync(root);
} catch (err) {
  opError(`could not resolve real path of repository root: ${err.message}`);
}

// ── base ref resolution ──────────────────────────────────────────────────────
// When --base is not passed, resolve the merge-base with a trunk candidate
// (main/master/origin/*). Defaulting to literal 'HEAD' would diff HEAD vs HEAD
// = empty diff = 0 mutants = a vacuous pass on a clean tree. Fail closed
// instead: if no trunk can be resolved, refuse to run and ask for --base.

let base = values.base;
if (base === undefined) {
  base = resolveBase(cwd);
  if (base === null) {
    opError(
      'could not resolve a base ref (no main/master/origin trunk found) — ' +
      'pass --base <ref> explicitly so the diff is non-empty'
    );
  }
}

// ── green baseline ────────────────────────────────────────────────────────────
// Run the unmutated test command ONCE before mutating anything. If it is not
// green, every mutant would trivially look "killed" (the suite already exits
// non-zero), turning the gate into a hollow pass. Refuse to run unless the real
// suite passes on unmutated code.

const baseline = runTest(testCmd, timeoutMs, cwd);
if (baseline.status !== 0) {
  // Report `reason` when the command could not be run to completion. Without it
  // a launch/buffer failure prints as "exit null", which reads as a failing
  // suite and sends the reader looking for a broken test that does not exist.
  const reason = baseline.timedOut
    ? 'timed out'
    : baseline.spawnFailed
      ? `could not run the test command: ${baseline.reason}`
      : `exit ${baseline.status}`;
  opError(
    `baseline suite is not green (${reason}) — cannot measure mutation kill; ` +
    'fix the suite / --test-cmd first'
  );
}

// ── diff + target selection ─────────────────────────────────────────────────

let diff;
try {
  diff = gitDiff(base, cwd);
} catch (err) {
  opError(`git diff failed: ${err.message}`);
}

const changedLines = mutate.changedLinesFromDiff(diff);
const diffEligibleFiles = filterTargetFiles(changedLines, { testGlobs, sourceGlobs });

// ── explicit --target / --rails resolution ──────────────────────────────────
// These bypass EXCLUDE_PATH_RE deliberately: the caller is asking, by name,
// to mutate a specific file that may not even appear in the diff (the P3
// rails-authoring / characterization-test ticket shapes — issues #70, #41).

// --target is resolved relative to `cwd` (ordinary CLI-arg convention — the
// caller types it relative to wherever they invoked hollow-test from), but
// normalized to a repo-root-relative path before use so it: (a) matches the
// path convention every other file in this tool uses (diff output, rails
// globs), and (b) can be containment-checked against the repo root. A path
// like `--target ../../../etc/passwd` (or an absolute path outside the repo)
// must be rejected rather than silently read/mutated — unlike --rails, whose
// globs can only ever match `git ls-files` output and therefore can never
// escape the repo, --target has no such structural guarantee on its own.
function escapesRoot(relPath) {
  return relPath === '' || relPath.split(sep)[0] === '..' || isAbsolute(relPath);
}

// Textual containment (escapesRoot() above) only catches `..`/absolute
// escapes in the path AS WRITTEN. It does nothing about a symlink that lives
// INSIDE the repo but points outside it: `path.resolve()`/`path.relative()`
// are purely lexical and never dereference symlinks, so `--target
// some-tracked-symlink/secret.mjs` resolves (textually) to a path under
// `root` and sails through escapesRoot() — while every actual read/write
// against that path (readFileSafe, the mutation loop's writeFileSync) is
// done by the OS, which DOES follow the symlink, straight through to
// wherever it points. Close that gap by re-resolving the real,
// symlink-free path and re-checking containment against the repo's real
// root. Returns the escaping real path (for the error message) or null if
// containment holds or the path doesn't exist yet (the caller's later
// "not found" check handles that case).
function symlinkEscapesRoot(absolutePath) {
  let real;
  try {
    real = realpathSync(absolutePath);
  } catch {
    return null;
  }
  const rel = relative(rootReal, real);
  return escapesRoot(rel) ? real : null;
}

const explicitTargets = (values.target ?? []).map((t) => {
  const abs = resolve(cwd, t);
  const rel = relative(root, abs);
  if (escapesRoot(rel)) {
    opError(
      `--target ${t} resolves outside the repository root (${root}) — refusing to read or mutate it`
    );
  }
  const realEscape = symlinkEscapesRoot(abs);
  if (realEscape !== null) {
    opError(
      `--target ${t} resolves inside the repository root textually but escapes it via a ` +
      `symlink (real path: ${realEscape}) — refusing to read or mutate it`
    );
  }
  return rel;
});

let railsGlobs = [];
for (const ticketFile of (values.rails ?? [])) {
  let globs;
  try {
    globs = readRailsFromTicketFile(resolve(cwd, ticketFile));
  } catch (err) {
    opError(`--rails ${ticketFile}: ${err.message}`);
  }
  if (globs.length === 0) {
    opError(`--rails ${ticketFile}: no "rails" declared (expected a non-empty array of paths/globs)`);
  }
  railsGlobs.push(...globs);
}

let railsFiles = [];
if (railsGlobs.length > 0) {
  let allFiles;
  try {
    // --full-name: `git ls-files` normally returns paths relative to the
    // CURRENT WORKING DIRECTORY it was invoked from (unlike `git diff`,
    // which is always repo-root-relative). Rails globs are naturally
    // authored repo-root-relative in ticket files, and every other path
    // this tool works with (diff-derived changedLines/filterTargetFiles) is
    // also repo-root-relative — so without --full-name, running hollow-test
    // from any subdirectory makes rails globs silently fail to match.
    allFiles = git(['ls-files', '--full-name'], { cwd }).split('\n').filter(Boolean);
  } catch (err) {
    opError(`git ls-files failed: ${err.message}`);
  }
  railsFiles = expandRailsToFiles(railsGlobs, allFiles);
  if (railsFiles.length === 0) {
    opError(`--rails declared globs matched no tracked files: ${railsGlobs.join(', ')}`);
  }
  // Defense in depth: git tracks symlinks as ordinary blobs, so a rails glob
  // can legitimately match a checked-in symlink whose target points outside
  // the repo — "globs can only ever match git ls-files output" (see the
  // comment above --target's resolution) is a guarantee about which
  // repo-relative PATHS can be named, not about what those paths dereference
  // to on disk. Apply the same real-path containment check used for
  // --target.
  for (const f of railsFiles) {
    const realEscape = symlinkEscapesRoot(resolve(root, f));
    if (realEscape !== null) {
      opError(
        `--rails matched ${f}, which resolves inside the repository root textually but ` +
        `escapes it via a symlink (real path: ${realEscape}) — refusing to read or mutate it`
      );
    }
  }
}

const explicitFiles = [...new Set([...explicitTargets, ...railsFiles])];
// The MUTABLE explicit set — computed once and used everywhere a decision
// depends on what will actually be mutated (budget allocation, starvation
// checks, post-run zero-mutant verification). `explicitFiles` above keeps every
// caller-named path and is for readability checks and reporting only.
//
// Getting this wrong is subtle: dropped non-source rails were removed from the
// mutation set but still checked by the post-run verifier, so a mixed
// source+JSON rails expansion did all the mutation work and THEN failed,
// claiming the JSON file produced zero mutants — exactly the behaviour the
// filtering was added to avoid.
const mutableExplicitFiles = [...new Set([...explicitTargets, ...railsFiles.filter(isSupportedSourceExtension)])];

// ── fail closed: every explicit --target/--rails file must be readable ─────
// Unlike diff-derived files (which came from a real git diff and should
// always exist), a --target path is caller-typed and a --rails glob can be
// stale. Previously an unreadable explicit file only produced a console.warn
// (nothing at all in --json mode) and was silently dropped — if it was the
// only target, `results` ended up empty and the pre-existing empty-results
// fallback exited 0 ("nothing mutable"), reporting a vacuous pass instead of
// surfacing the real cause. Refuse to run instead.
for (const f of explicitFiles) {
  if (readFileSafe(resolve(root, f)) === null) {
    opError(
      `--target/--rails file not found or unreadable: ${f} — ` +
      'a mistyped path, deleted/renamed file, or stale rails entry would ' +
      'otherwise silently produce a vacuous 0-mutant pass'
    );
  }
}

// ── fail closed: a diff with nothing eligible and no explicit target/rails ──
// is indistinguishable, in the OLD behavior, from a genuinely strong suite
// (0 mutants, exit 0). A rails-only or test-only diff (P3 characterization /
// rails-authoring tickets) must not silently satisfy this gate — refuse to
// run instead, and point the caller at --target/--rails (issues #70, #41).

if (diffEligibleFiles.length === 0 && explicitFiles.length === 0) {
  opError(
    'nothing to mutate — the diff contains no eligible source files ' +
    '(only test/spec/non-code files changed). Pass --target <file> or ' +
    '--rails <ticket-file> to declare mutation target(s) explicitly ' +
    '(e.g. for a rails-authoring or characterization-test ticket).'
  );
}

// Explicit targets always mutate the WHOLE file, not just diff-changed
// lines — drop any diff line-restriction for files the caller named directly.
const effectiveChangedLines = { ...changedLines };
for (const f of explicitFiles) delete effectiveChangedLines[f];

// FAIL CLOSED on explicit targets in an UNSUPPORTED LANGUAGE — but only the
// language half of the predicate. Explicit --target/--rails paths deliberately
// bypass test-path exclusion: rails ARE test files, which is the entire point of
// the P3 rails-authoring workflow. Using the full isMutableSource here rejected
// every rail under a test/ directory and broke that documented contract.
//
// The language guard still matters. Operators are JS/TS-shaped, and runner.mjs
// scores `killed = timedOut || status !== 0`, so a mutant that renders a .py or
// .css file syntactically invalid makes the test command fail and is recorded as
// KILLED — a false green on the gate built to detect false greens.
//
// --target and --rails are treated differently on purpose:
//   --target  the caller typed ONE path. Refuse loudly; silently dropping it
//             would be its own silent-pass bug.
//   --rails   a glob EXPANSION legitimately matches non-source (schemas/**,
//             JSON, fixtures). Filter those out, say which were dropped, and
//             fail only if nothing mutable remains.
const unsupportedTargets = explicitTargets.filter((f) => !isSupportedSourceExtension(f));
if (unsupportedTargets.length > 0) {
  opError(
    `--target ${unsupportedTargets.join(', ')} is not a supported source language — ` +
    `mutation operators are JS/TS-shaped, and mutating another language yields ` +
    `syntactically invalid code that is scored as "killed" rather than testing ` +
    `anything.`
  );
}

const droppedRails = railsFiles.filter((f) => !isSupportedSourceExtension(f));
if (droppedRails.length > 0) {
  console.warn(
    `hollow-test: ${droppedRails.length} --rails match(es) are not a supported source ` +
    `language and will not be mutated: ${droppedRails.join(', ')}`
  );
}
const mutableRails = railsFiles.filter(isSupportedSourceExtension);
if (railsFiles.length > 0 && mutableRails.length === 0) {
  opError(
    `--rails matched ${railsFiles.length} file(s), none of which are a supported ` +
    `source language (${[...new Set(railsFiles.map((f) => f.replace(/^.*(\.[^.]*)$/, '$1')))].join(', ')}) — ` +
    `nothing could be mutated, which would otherwise report a vacuous pass.`
  );
}

const allTargetFiles = [...new Set([...diffEligibleFiles, ...mutableExplicitFiles])];
// explicitFiles are passed as a priority list so the --max budget can't
// starve them to quota 0 when diff-derived files alone would consume it —
// see buildFileTargets() in lib/targets.mjs.
const fileTargets = buildFileTargets(allTargetFiles, effectiveChangedLines, maxMutants, root, mutableExplicitFiles);

// ── fail closed: --max too small to cover every explicit target ────────────
// buildFileTargets() reserves 1 quota per explicit file when the budget
// allows it. If --max is smaller than the number of explicit targets, some
// of them still can't be guaranteed a slot — refuse to run rather than
// silently mutating a subset and reporting a full pass.
const starvedByBudget = fileTargets.filter(
  (t) => mutableExplicitFiles.includes(t.file) && t.quota === 0
);
if (starvedByBudget.length > 0) {
  opError(
    `--max ${maxMutants} is too small to allocate mutation budget to explicit ` +
    `target(s): ${starvedByBudget.map((t) => t.file).join(', ')} — increase ` +
    `--max to at least ${mutableExplicitFiles.length}, or reduce the number of ` +
    'explicit --target/--rails files'
  );
}

// ── SIGINT handler: track which file is currently mutated so we can restore ──

let currentFilePath = null;
let currentOriginal = null;

let shuttingDown = false;

function emergencyRestore() {
  let restored = true;
  if (currentFilePath !== null && currentOriginal !== null) {
    try {
      writeFileAtomic(currentFilePath, currentOriginal);
    } catch {
      // Best-effort — we're in a signal handler.
      restored = false;
    }
  }
  // Only drop the record once the file is actually back, and only once those
  // bytes are durable — the record's removal is.
  if (restored) clearInflight();
}

// SIGINT only, deliberately, in THIS change.
//
// Handling more signals is not a free win: registering a handler SUPPRESSES the
// default termination, and the trial loop is synchronous over spawnSync, so the
// handler cannot be dispatched until every remaining mutant has run. Measured on
// an 8-mutant run: 24.6 seconds from SIGTERM to exit. Adding SIGTERM/SIGHUP here
// would therefore make cancellation WORSE, not better. Making it work needs an
// asynchronous runner, which is a separate change.
//
// The in-flight record above already covers what matters here: a SIGTERM that
// kills us outright strands a mutant, and the NEXT run puts it back.
process.on('SIGINT', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  emergencyRestore();
  process.exit(1);
});

// ── mutation loop ────────────────────────────────────────────────────────────

const results = [];

for (const target of fileTargets) {
  const content = readFileSafe(target.absolutePath);
  if (content === null) {
    if (!useJson) {
      console.warn(`warning: could not read ${target.file} — skipping`);
    }
    continue;
  }

  const mutants = mutate.generateMutants(content, {
    targetLines: target.targetLines,
    maxMutants: target.quota,
  });

  for (const mutant of mutants) {
    let mutatedContent;
    try {
      mutatedContent = mutate.applyMutant(content, mutant);
    } catch (err) {
      if (!useJson) {
        console.warn(`warning: could not apply mutant at ${target.file}:${mutant.line} — ${err.message}`);
      }
      continue;
    }

    // Register for emergency restore twice over: in memory for a signal we can
    // catch, and on disk for one we cannot.
    //
    // FAIL CLOSED if the record cannot be written. Swallowing the error would
    // mutate the file with no way back — precisely the SIGKILL case the record
    // exists for, silently unprotected. The mutant bytes go in too, so recovery
    // can PROVE the file is still what we wrote before overwriting it.
    currentFilePath = target.absolutePath;
    currentOriginal = content;
    if (inflightPath !== null) {
      try {
        writeRecord(inflightPath, {
          pid: process.pid,
          relFile: relative(root, target.absolutePath),
          original: content,
          mutated: mutatedContent,
        });
      } catch (err) {
        opError(
          `could not write the in-flight record (${err.message}) — refusing to mutate ` +
          `${target.file}, because a run interrupted now could not be recovered`
        );
      }
    }

    const trial = runMutant(
      target.absolutePath,
      content,
      mutatedContent,
      testCmd,
      timeoutMs,
      cwd
    );

    // Trial done; the file is restored, so clear both emergency records.
    //
    currentFilePath = null;
    currentOriginal = null;
    clearInflight();

    results.push({
      file: target.file,
      line: mutant.line,
      operator: mutant.operator,
      killed: trial.killed,
      invalid: trial.invalid === true,
      undetermined: trial.undetermined === true,
      reason: trial.reason ?? null,
      timedOut: trial.timedOut,
      original: mutant.original,
      mutated: mutant.mutated,
    });
  }
}

// ── fail closed: an explicit target that generated zero mutants was never ──
// actually verified. A file can be readable and have nonzero quota yet still
// produce no mutants (comment-only, blank, re-export-only, or otherwise no
// line matches any operator). Falling through to the generic
// "results.length === 0 -> pass" shortcut below (or a legitimate pass driven
// entirely by unrelated diff-derived mutants) would silently report a full
// pass without ever exercising the file the caller explicitly asked to
// prosecute — exactly the vacuous-pass class issues #70/#41/#35 exist to
// close. Distinguish this from the legitimate "every mutant was killed" case
// by checking per-file counts rather than results.length overall.
if (mutableExplicitFiles.length > 0) {
  const mutantCountByFile = {};
  for (const r of results) {
    mutantCountByFile[r.file] = (mutantCountByFile[r.file] ?? 0) + 1;
  }
  const starvedExplicitFiles = mutableExplicitFiles.filter((f) => !mutantCountByFile[f]);
  if (starvedExplicitFiles.length > 0) {
    opError(
      'explicit --target/--rails file(s) produced zero mutants — ' +
      `${starvedExplicitFiles.join(', ')}: no mutable line was found (comment-only, ` +
      'blank, or a shape none of the mutation operators recognize). The requested ' +
      'target was never actually verified; refusing to report a pass.'
    );
  }
}

// Could not determine validity for some mutant — refuse to report a verdict.
// Scoring it either way is a guess, and the guess that reopens #293 is the
// convenient one.
const undetermined = results.filter((r) => r.undetermined);
if (undetermined.length > 0) {
  const where = undetermined.map((r) => `${r.file}:${r.line}${r.reason ? ` (${r.reason})` : ''}`).join(', ');
  opError(
    `could not syntax-check ${undetermined.length} mutant(s) (${where}) — the checker did ` +
    `not run to completion, so whether they were valid is unknown. Refusing to score them: ` +
    `treating an unknown as valid is how an unparseable mutant gets credited as a kill (#293).`
  );
}

// ── reporting ────────────────────────────────────────────────────────────────

const survivors = results.filter((r) => !r.killed && !r.invalid);
const invalidMutants = results.filter((r) => r.invalid);

if (useJson) {
  // `recovered` is reported as data, not just a log line, so a caller running
  // --json can tell that this run began by cleaning up after an interrupted one.
  printJson({
    ...buildJsonReport(results),
    ...(recoveredInflight !== null ? { recovered: recoveredInflight } : {}),
  });
} else {
  printTable(results);
}

// ── exit ─────────────────────────────────────────────────────────────────────

if (results.length === 0) {
  const warnMsg = 'warning: no mutants generated from diff — nothing mutable in diff';
  if (!useJson) console.warn(warnMsg);
  pass();
}

// FAIL CLOSED when nothing valid ever ran (#293). If every mutant was
// syntactically invalid, no assertion was exercised and the gate proved exactly
// nothing — passing here is the false green this check exists to prevent.
// Reported as an OPERATIONAL failure, not a gate failure: the tests are not at
// fault, the mutations were.
// PER-FILE, not just globally. A file whose every mutant was invalid received no
// coverage check at all — and a global test hides that whenever some OTHER file
// produced a kill. That is most acute for an explicit --target/--rails file: the
// caller named it deliberately, and the run would report success without a
// single test having exercised it.
// Seeded from the SELECTED TARGETS, not from results: a file that produced no
// result at all (no recognised mutant, or everything skipped before push) is
// exactly the case that must not slip through as "no news is good news".
const validByFile = new Map(fileTargets.map((t) => [t.file, 0]));
for (const r of results) {
  const prev = validByFile.get(r.file) ?? 0;
  validByFile.set(r.file, prev + (r.invalid || r.undetermined ? 0 : 1));
}
// EVERY file in the run, not only explicit targets. Restricting this to
// --target/--rails left the same hole one step over: a diff-derived file whose
// mutants were all invalid is equally unchecked, and any other file's kill hides
// it. Whether the caller named the file or the diff did, zero valid mutants
// means zero evidence about it.
// Two different zero-valid cases, and conflating them is wrong in both
// directions:
//
//   ATTEMPTED but every mutant invalid/undetermined -> hard failure. A trial ran
//   and produced no evidence, which is the #293 false-green.
//
//   NEVER ATTEMPTED (quota 0 from budget distribution) -> reported, not fatal.
//   Reserving budget for explicit targets while diff-derived files share what is
//   left is the documented design (#70/#41/#35); refusing outright would break
//   it. But it must not be SILENT — a file the gate never looked at is exactly
//   the place to hide an untested change.
const attempted = new Set(results.map((r) => r.file));
const quotaByFile = new Map(fileTargets.map((t) => [t.file, t.quota]));
// Two reasons a selected file produced nothing, and only one is a budget
// problem. Saying "no budget" for a file whose changed lines were all comments
// is a false alarm, and false alarms are how real warnings stop being read.
const starved = [...validByFile.keys()].filter((f) => !attempted.has(f) && (quotaByFile.get(f) ?? 0) === 0);
const noMutableLines = [...validByFile.keys()].filter((f) => !attempted.has(f) && (quotaByFile.get(f) ?? 0) > 0);
if (starved.length > 0) {
  console.warn(
    `hollow-test: ${starved.length} selected file(s) received no mutation budget and were ` +
    `NOT prosecuted: ${starved.join(', ')} — raise --max to cover them.`
  );
}
if (noMutableLines.length > 0) {
  console.warn(
    `hollow-test: ${noMutableLines.length} selected file(s) had budget but no mutable lines ` +
    `(comments, imports, blank): ${noMutableLines.join(', ')}`
  );
}

const unchecked = [...validByFile.entries()]
  .filter(([f, valid]) => valid === 0 && attempted.has(f))
  .map(([f]) => f);
if (unchecked.length > 0) {
  const named = unchecked.filter((f) => mutableExplicitFiles.includes(f));
  opError(
    `every mutant generated for ${unchecked.join(', ')} was syntactically invalid — no test ` +
    `ran against ${unchecked.length === 1 ? 'it' : 'them'}, so this run says nothing about ` +
    `${named.length > 0 ? 'the file(s) you asked to prosecute' : 'those changed file(s)'}. ` +
    `Raise --max so a valid mutant is reached (see #293).`
  );
}

if (invalidMutants.length === results.length) {
  const msg =
    `every one of the ${results.length} generated mutant(s) was syntactically invalid, so ` +
    `no assertion was ever exercised — this run proves nothing. Line-based operators can ` +
    `produce unparseable code on multiline constructs (see issue #293); raise --max so a ` +
    `valid mutant is reached, or narrow --target to a file with mutable single-line logic.`;
  if (useJson) {
    console.error(`error: ${msg}`);
    process.exit(1);
  }
  opError(msg);
}

if (survivors.length > 0) {
  const failMsg = `hollow coverage — ${survivors.length} mutation(s) pass your tests`;
  if (useJson) {
    // JSON was already printed; just exit with code 2.
    process.exit(2);
  }
  gateFail(failMsg);
}

pass(useJson ? undefined : 'All mutants killed — coverage gate passes');
