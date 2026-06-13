#!/usr/bin/env node
// hollow-test — diff-scoped mutation gate (ADLC C4)
// Refuses to run on a dirty working tree. Mutates files in place and
// restores them via finally blocks + SIGINT handler.

import { writeFileSync } from 'node:fs';
import { parseArgs, pass, gateFail, opError, printJson } from '@adlc/core';
import { gitDiff, isDirty, isGitRepo, resolveBase, mutate } from '@adlc/core';
import { filterTargetFiles, buildFileTargets, readFileSafe } from '../lib/targets.mjs';
import { runMutant, runTest } from '../lib/runner.mjs';
import { printTable, buildJsonReport } from '../lib/report.mjs';

// ── arg parsing ─────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    'test-cmd':   { type: 'string' },
    base:         { type: 'string' },
    max:          { type: 'string', default: '20' },
    'timeout-ms': { type: 'string', default: '120000' },
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
  --json                Machine-readable JSON output
  --help                Show this help

Exit codes:
  0  All mutants killed (gate passes)
  1  Operational error (dirty tree, not a git repo, bad args)
  2  One or more mutants survived (hollow coverage)
`);
  process.exit(values.help ? 0 : 1);
}

const testCmd   = values['test-cmd'];
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
const eligibleFiles = filterTargetFiles(changedLines);
const fileTargets = buildFileTargets(eligibleFiles, changedLines, maxMutants, cwd);

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
