#!/usr/bin/env node
// hollow-test — diff-scoped mutation gate (ADLC C4)
// Refuses to run on a dirty working tree. Mutates files in place and
// restores them via finally blocks + SIGINT handler.

import { writeFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { parseArgs, pass, gateFail, opError, printJson } from '@adlc/core';
import { gitDiff, isDirty, isGitRepo, resolveBase, mutate, git, repoRoot } from '@adlc/core';
import {
  filterTargetFiles, buildFileTargets, readFileSafe,
  readRailsFromTicketFile, expandRailsToFiles, isMutableSource, isSupportedSourceExtension,
} from '../lib/targets.mjs';
import { runMutant, runTest } from '../lib/runner.mjs';
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
  1  Operational error (dirty tree, not a git repo, bad args, nothing to mutate)
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

if (isDirty(cwd)) {
  opError('commit or stash first — hollow-test mutates files in place and restores them');
}

// Repo root — NOT necessarily `cwd`. hollow-test may be invoked from any
// subdirectory (e.g. a per-package script that `cd`s into packages/foo/
// first), so anything that needs to reason about the repo as a whole
// (rails-glob matching, --target containment) must resolve against this,
// not `cwd`.
let root;
try {
  root = repoRoot(cwd);
} catch (err) {
  opError(`could not resolve repository root: ${err.message}`);
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
  const reason = baseline.timedOut ? 'timed out' : `exit ${baseline.status}`;
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

function emergencyRestore() {
  if (currentFilePath !== null && currentOriginal !== null) {
    try {
      writeFileSync(currentFilePath, currentOriginal, 'utf8');
    } catch {
      // Best-effort — we're in a signal handler.
    }
  }
}

process.on('SIGINT', () => {
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

    // Register for emergency SIGINT restore.
    currentFilePath = target.absolutePath;
    currentOriginal = content;

    const trial = runMutant(
      target.absolutePath,
      content,
      mutatedContent,
      testCmd,
      timeoutMs,
      cwd
    );

    // Trial done; clear emergency state.
    currentFilePath = null;
    currentOriginal = null;

    results.push({
      file: target.file,
      line: mutant.line,
      operator: mutant.operator,
      killed: trial.killed,
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

// ── reporting ────────────────────────────────────────────────────────────────

const survivors = results.filter((r) => !r.killed);

if (useJson) {
  printJson(buildJsonReport(results));
} else {
  printTable(results);
}

// ── exit ─────────────────────────────────────────────────────────────────────

if (results.length === 0) {
  const warnMsg = 'warning: no mutants generated from diff — nothing mutable in diff';
  if (!useJson) console.warn(warnMsg);
  pass();
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
