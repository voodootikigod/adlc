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
// WHY THIS DOES NOT USE --target (v2 — read this before reintroducing it).
// The first version passed every in-scope source file to hollow-test as an
// explicit `--target`. hollow-test's OWN documented contract for `--target` is
// "mutate the WHOLE file, independent of the diff" — it deletes that file's
// diff-derived line restriction unconditionally, even when the file IS in the
// diff (see hollow-test/bin/hollow-test.mjs: "Explicit targets always mutate
// the WHOLE file... drop any diff line-restriction for files the caller named
// directly"). Every file this wrapper selects already comes FROM the diff, so
// --target bought nothing for file SELECTION — it only forced whole-file
// mutation where hunk-scoping was already available. That surfaced for real on
// #255: mutants landed on unrelated, already-shipped lines inside
// packages/core/lib/git.mjs (from #249, merged separately), blocking a correct,
// unrelated PR on pre-existing debt it had no way to have tested — and it would
// have recurred on every future PR that merely touched a large file.
//
// There is a second, worse bug --target never caused but also never prevented:
// hollow-test computes `diffEligibleFiles` from the diff UNCONDITIONALLY, before
// even looking at --target, and unions it with the explicit set. So a file this
// wrapper meant to SKIP (e.g. something under scripts/**) was mutated by
// hollow-test's own independent scan regardless — and tested against a
// --test-cmd that never touches it, guaranteeing a false SURVIVED on any PR that
// happened to change a scripts/ file alongside a packages/ file. There is no
// --exclude flag to suppress this from our side.
//
// Given both, the only sound design is: never pass --target (get hunk-scoping
// for free from hollow-test's own diff mode), and make --test-cmd cover EVERY
// eligible file hollow-test would independently discover. When a source file
// doesn't map to a known fast test directory, we cannot safely predict what
// hollow-test will do with it — so we fall back to the full monorepo suite
// (slow, but never wrong) rather than silently leaving it untested.
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
const requestedMax = maxFlag >= 0 ? Number(args[maxFlag + 1]) : 12;

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
 * Map a changed file to the test directory that covers it, mirroring
 * hollow-test's own eligibility filter closely enough to reason about what its
 * independent diff scan will pick up (test/spec paths and non-code extensions
 * excluded — see hollow-test/lib/targets.mjs EXCLUDE_PATH_RE / EXCLUDE_EXT_RE).
 *
 * Deliberately conservative: a file that maps to no known test directory
 * contributes NO command here, and the caller must treat that as "cannot
 * guarantee coverage" rather than "safe to ignore" — see the fallback below.
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

// hollow-test's own exclusion: test/spec paths and non-code extensions. A file
// matching this is one hollow-test would NEVER independently select, so it is
// safe to ignore for test-cmd coverage purposes regardless of which directory
// it lives in.
const HOLLOW_TEST_EXCLUDE_PATH = /(?:test|spec)/i;
const HOLLOW_TEST_EXCLUDE_EXT = /\.(?:md|json|yml|yaml|lock|txt|toml|snap)$/i;
function hollowTestWouldMutate(file) {
  if (HOLLOW_TEST_EXCLUDE_PATH.test(file)) return false;
  if (HOLLOW_TEST_EXCLUDE_EXT.test(file)) return false;
  return true;
}

// Every file hollow-test's OWN diff scan would independently select — this is
// what actually gets mutated, regardless of anything else this script does.
const eligible = changed.filter(hollowTestWouldMutate);

if (eligible.length === 0) {
  console.log('mutation-gate: no source files changed — nothing to mutate.');
  process.exit(0);
}

const covered = [];   // [file, testDir]
const uncovered = []; // file with no known fast test directory

for (const file of eligible) {
  const dir = testDirFor(file);
  if (dir) covered.push([file, dir]);
  else uncovered.push(file);
}

console.log(`mutation-gate: base=${base}`);

let testCmd;
let max = requestedMax;

if (uncovered.length === 0) {
  // FAST PATH. Every file hollow-test will discover maps to a known, quick
  // test directory. No --target: hollow-test hunk-scopes these files itself
  // from the same diff, which is strictly more precise than anything we could
  // do by re-deriving line numbers here.
  const dirs = [...new Set(covered.map(([, d]) => d))].sort();
  testCmd = dirs.map((d) => `node --test ${d}/*.test.mjs`).join(' && ');
  console.log(`mutation-gate: ${eligible.length} file(s) covered by fast test dirs → ${testCmd}`);
} else {
  // SLOW FALLBACK. At least one file hollow-test will mutate has no fast,
  // known-correct test command — most commonly something under scripts/**,
  // which has no per-file test directory at all. Guessing "skip it" here is
  // exactly the bug this rewrite fixes: hollow-test would mutate it anyway via
  // its own independent scan, and a --test-cmd that never touches it would
  // report a guaranteed false SURVIVED. The only sound fallback is a test
  // command broad enough to actually exercise it — the full monorepo suite.
  console.log(`mutation-gate: ${uncovered.length} file(s) have no known fast test directory — falling back to the FULL suite:`);
  for (const f of uncovered) console.log(`  ${f}`);
  testCmd = 'node scripts/run-tests.mjs';
  // The full suite is ~9.5 minutes per run; keep the fallback's mutant budget
  // small regardless of what --max requested, so a scripts/-touching PR still
  // finishes in bounded CI time rather than silently taking hours.
  max = Math.min(requestedMax, 3);
  console.log(`mutation-gate: capping budget at ${max} mutant(s) for the slow path (requested ${requestedMax})`);
}

// NO --target. hollow-test independently re-derives the same file set from the
// same --base and hunk-scopes each one from the diff itself.
const bin = join(ROOT, 'packages', 'hollow-test', 'bin', 'hollow-test.mjs');
const result = spawnSync(process.execPath, [
  bin,
  '--base', base,
  '--test-cmd', testCmd,
  '--max', String(max),
  '--timeout-ms', uncovered.length === 0 ? '180000' : '600000',
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
