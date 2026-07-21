#!/usr/bin/env node
// mutation-gate — CI wrapper that runs the diff-scoped mutation gate (C4) with a
// test command scoped to the packages the diff actually touches.
//
// WHY THIS EXISTS. `adlc hollow-test` runs the test command ONCE PER MUTANT, so
// the command's cost is multiplied. The full suite takes ~9.5 minutes here, which
// makes even five mutants unshippable in CI. Scoping to the changed packages
// brings a mutant down to seconds, which is what makes the gate practical at all.
//
// WHAT IT DEFENDS. A guard added without a test that notices its removal. That
// failure recurred FIVE times inside a single ticket (#228 / #234) — a structural
// check whose mechanism no test exercised, two symlink fixtures that passed for
// unrelated reasons, and completeness fixtures that all left the same side wrong.
// Three of the five were caught only by external review. Every one of them is
// exactly what a surviving mutant looks like.
//
//   node scripts/mutation-gate.mjs [base-ref] [--max N]
//
// Exit: 0 = all mutants killed or nothing to mutate · 2 = a mutant survived ·
//       1 = operational error.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith('--')) || process.env.MUTATION_BASE || 'origin/main';
const maxFlag = args.indexOf('--max');
const max = maxFlag >= 0 ? args[maxFlag + 1] : '12';

function fail(msg) {
  console.error(`mutation-gate: ${msg}`);
  process.exit(1);
}

function git(gitArgs) {
  const r = spawnSync('git', gitArgs, { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
  if (r.error) fail(`git ${gitArgs[0]} failed: ${r.error.message}`);
  return r;
}

// The base must resolve. `git diff <bad-ref>` fails loudly, but an unfetched base
// in CI is an operational problem, not "nothing changed" — say so rather than
// passing an empty diff.
if (git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status !== 0) {
  fail(`base ref '${base}' does not resolve — fetch it or pass the correct base`);
}

const diff = git(['diff', '--name-only', '-z', base, '--']);
if (diff.status !== 0) fail('git diff failed');
const changed = diff.stdout.split('\0').filter(Boolean);

/**
 * Map changed files to the test commands that cover them.
 *
 * Deliberately conservative: a file that maps to no known test directory
 * contributes NO command, and if nothing maps we skip rather than mutate a file
 * whose tests we cannot locate. A mutation run against the wrong test command
 * would report confident nonsense in both directions.
 */
function testDirFor(file) {
  let m;
  if ((m = /^packages\/([^/]+)\//.exec(file))) {
    const d = `packages/${m[1]}/test`;
    return existsSync(join(ROOT, d)) ? d : null;
  }
  if ((m = /^plugins\/([^/]+)\/(hooks|lib|agents|mcp)\//.exec(file))) {
    const d = `plugins/${m[1]}/${m[2]}/test`;
    return existsSync(join(ROOT, d)) ? d : null;
  }
  if ((m = /^plugins\/([^/]+)\//.exec(file))) {
    const d = `plugins/${m[1]}/test`;
    return existsSync(join(ROOT, d)) ? d : null;
  }
  return null;
}

// Only source files are worth mutating; a mutated test proves nothing about the
// code. hollow-test excludes test paths itself, but filtering here keeps the
// test-command mapping honest about what is actually under test.
const sources = changed.filter((f) =>
  /\.(mjs|js|cjs)$/.test(f) && !/(^|\/)(test|tests)\//.test(f) && !/\.test\.mjs$/.test(f));

if (sources.length === 0) {
  console.log('mutation-gate: no source files changed — nothing to mutate.');
  process.exit(0);
}

// NAME WHAT IS NOT COVERED. A gate that quietly opts out of a directory is the
// same hollow-coverage failure it exists to prevent, so every skipped file is
// printed with its reason rather than folded into a silent pass.
//
// `scripts/**` is out of scope on cost: its suite takes ~9.5 MINUTES, and
// hollow-test reruns the command once per mutant, so a dozen mutants there is
// ~2 hours. Bringing it in scope needs that suite to get faster first — tracked
// separately, not papered over here.
const covered = [];
const skipped = [];
for (const file of sources) {
  const dir = testDirFor(file);
  if (dir) covered.push([file, dir]);
  else skipped.push(file);
}

console.log(`mutation-gate: base=${base} max=${max}`);
if (skipped.length) {
  console.log(`mutation-gate: NOT MUTATED (${skipped.length} file(s), no in-scope test suite):`);
  for (const f of skipped) {
    const why = f.startsWith('scripts/')
      ? 'scripts/test is too slow to mutate (~9.5min/run)'
      : 'no test directory maps to this path';
    console.log(`  ${f}  — ${why}`);
  }
}

if (covered.length === 0) {
  console.log('mutation-gate: nothing in scope to mutate — passing, but see the list above.');
  process.exit(0);
}

const dirs = [...new Set(covered.map(([, d]) => d))].sort();
const targets = covered.map(([f]) => f);
const testCmd = dirs.map((d) => `node --test ${d}/*.test.mjs`).join(' && ');
console.log(`mutation-gate: mutating ${targets.length} file(s) → ${testCmd}`);

// Pass the in-scope files as explicit --target rather than letting hollow-test
// re-derive them from the diff: its diff would still include the paths listed as
// skipped above, and mutating those would run the slow suite we just excluded.
const bin = join(ROOT, 'packages', 'hollow-test', 'bin', 'hollow-test.mjs');
const result = spawnSync(process.execPath, [
  bin,
  '--base', base,
  '--test-cmd', testCmd,
  '--max', String(max),
  // Each suite must fit comfortably; the slowest in-scope one is seconds, but a
  // mutant that hangs should be reported as a timeout rather than killing CI.
  '--timeout-ms', '180000',
  ...targets.flatMap((t) => ['--target', t]),
], { stdio: 'inherit', cwd: ROOT, timeout: 1800000 });

if (result.error) fail(`could not run hollow-test: ${result.error.message}`);
if (result.signal) fail(`hollow-test timed out or was killed by ${result.signal}`);

if (result.status === 2) {
  console.error('');
  console.error('mutation-gate: a mutant SURVIVED — some changed code has no test that notices it changing.');
  console.error('This is the hollow-test failure mode: a guard can be correct and still be unverified.');
  console.error('Either add a test that fails when that line is altered, or, if the line is genuinely');
  console.error('redundant with a stronger check, say so in a comment AT ITS DEFINITION and re-run.');
}
process.exit(typeof result.status === 'number' ? result.status : 1);
