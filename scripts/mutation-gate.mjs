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
// doesn't map to a known fast test target, we cannot safely predict what
// hollow-test will do with it — so we fall back to the full monorepo suite
// (slow, but never wrong) rather than silently leaving it untested.
//
// v3 — the slow fallback ITSELF turned out unsafe in the CI job that runs it.
// `node scripts/run-tests.mjs` includes segments needing globally-installed
// `codex`/`opencode`/`pi` CLIs, which the `test` job's workflow provisions but
// the `mutation-gate` job's workflow does not (it only runs `npm ci`). The very
// first real use of the slow fallback — this file's own PR, since this file
// itself lives under scripts/** and had no dedicated test — failed on that
// mismatch, not on the mutation logic. Two fixes: (1) this file now has a real
// test (scripts/test/mutation-gate.test.mjs), and (2) `scripts/<name>.mjs` maps
// to `scripts/test/<name>.test.mjs` when that exact file exists, the same
// same-basename convention already used by release.mjs/ceremony-drift.mjs/etc,
// so a scripts/ file WITH direct coverage takes the fast, single-file path
// instead of ever reaching the slow fallback. Files without such a test still
// correctly fall through to the slow path — this narrows the unsafe fallback's
// blast radius, it does not eliminate the environment mismatch for those.
//
//   node scripts/mutation-gate.mjs [base-ref] [--max N]
//
// Exit: 0 = all mutants killed or nothing to mutate · 2 = a mutant survived ·
//       1 = operational error.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMutableSource } from '../packages/hollow-test/lib/targets.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Map a changed file to the fast test TARGET that covers it — a directory glob
 * (`pkg/test/*.test.mjs`) for packages/plugins, or a single same-basename test
 * file for a scripts/ source (`scripts/foo.mjs` → `scripts/test/foo.test.mjs`),
 * mirroring the convention already used by release.mjs, ceremony-drift.mjs, etc.
 *
 * Deliberately conservative: a file that maps to nothing contributes NO target,
 * and the caller must treat that as "cannot guarantee coverage" rather than
 * "safe to ignore" — see classify() below.
 *
 * @param {string} file  repo-relative path
 * @param {string} [root]  repo root, for the existsSync checks (testable with a
 *        fixture root without touching the real filesystem layout)
 * @returns {string|null} a `node --test`-able target, or null if unknown
 */
export function testTargetFor(file, root = ROOT) {
  let m;
  if ((m = /^packages\/([^/]+)\//.exec(file))) {
    const d = `packages/${m[1]}/test`;
    return existsSync(join(root, d)) ? `${d}/*.test.mjs` : null;
  }
  if ((m = /^apps\/([^/]+)\//.exec(file))) {
    const d = `apps/${m[1]}/test`;
    return existsSync(join(root, d)) ? `${d}/*.test.mjs` : null;
  }
  if ((m = /^plugins\/([^/]+)\/(hooks|lib|agents|mcp)\//.exec(file))) {
    const d = `plugins/${m[1]}/${m[2]}/test`;
    if (existsSync(join(root, d))) return `${d}/*.test.mjs`;
  }
  if ((m = /^plugins\/([^/]+)\//.exec(file))) {
    const d = `plugins/${m[1]}/test`;
    return existsSync(join(root, d)) ? `${d}/*.test.mjs` : null;
  }
  if ((m = /^scripts\/([^/]+)\.(?:mjs|cjs|js)$/.exec(file))) {
    const f = `scripts/test/${m[1]}.test.mjs`;
    if (existsSync(join(root, f))) return f;
    if (m[1] === 'pi-live-deny' && existsSync(join(root, 'plugins/adlc-pi/test'))) return 'plugins/adlc-pi/test/*.test.mjs';
    return null;
  }
  return null;
}

// Source classification lives in ONE place — packages/hollow-test/lib/targets.mjs
// — and is imported, not re-stated. This wrapper previously kept its own copy of
// hollow-test's extension regex, and the two drifted. Drift is silent in the
// dangerous direction: if the wrapper decides a file is not source, hollow-test
// is never invoked for it, so the required gate goes green without testing the
// change. Re-declaring the predicate here, however carefully, recreates that.
// scripts/test/mutation-gate.test.mjs asserts the two agree.
// This repository owns two production files whose names match a test convention
// (`node --test` discovers `*-test.*`). Convention cannot resolve the ambiguity,
// so the project declares it — mirrored into the hollow-test invocation below as
// --source-glob, so the wrapper and the tool agree.
export const SOURCE_GLOBS = ['**/hollow-test.mjs', '**/spec-lint.mjs'];

export function hollowTestWouldMutate(file) {
  return isMutableSource(file, { sourceGlobs: SOURCE_GLOBS });
}

/**
 * Pure classification: given the set of changed files, decide the test
 * command and mutant budget. No I/O beyond testTargetFor's existsSync checks.
 *
 * @param {string[]} changed  repo-relative changed file paths
 * @param {number} requestedMax
 * @param {string} [root]
 * @returns {
 *   | { kind: 'nothing' }
 *   | { kind: 'fast', testCmd: string, max: number, files: string[] }
 *   | { kind: 'slow', testCmd: string, max: number, uncovered: string[] }
 * }
 */
export function classify(changed, requestedMax, root = ROOT) {
  const eligible = changed.filter(hollowTestWouldMutate);
  // Carried by EVERY classification, not just the empty one. Populating it only
  // on the 'nothing' branch left the mixed case silent — one tested source file
  // plus a stylesheet takes the fast path, and the stylesheet vanishes from the
  // report. That run is green AND busy, so nothing hints a file went uncovered.
  const skipped = changed.filter((f) => !hollowTestWouldMutate(f));
  // Report what was skipped. A green gate must not be a SILENT green: a diff of
  // files this tool does not mutate (CSS, MDX, docs) exits 0, and without naming
  // them "the gate passed" is indistinguishable from "the gate looked".
  //
  // Deliberately NOT solved by widening the source set. The shared mutator is
  // regex-based with JS-shaped operators; on CSS it emits nonsense
  // (`html > body` -> `html <= body`) alongside one real behavioural mutant
  // (`opacity: 0` -> `opacity: 1`) that no test here could kill, since there are
  // no CSS tests. Admitting it would pin the required gate permanently red on
  // any stylesheet change — worse than declaring the type uncovered out loud.
  if (eligible.length === 0) return { kind: 'nothing', skipped };

  const covered = [];   // [file, testTarget]
  const uncovered = [];
  for (const file of eligible) {
    const target = testTargetFor(file, root);
    if (target) covered.push([file, target]);
    else uncovered.push(file);
  }

  if (uncovered.length === 0) {
    // FAST PATH. Every file hollow-test will discover maps to a known, quick
    // test target. No --target passed to hollow-test itself: it hunk-scopes
    // these files from the same diff, more precisely than we could re-derive.
    const targets = [...new Set(covered.map(([, t]) => t))].sort();
    return {
      kind: 'fast',
      testCmd: targets.map((t) => `node --test ${t}`).join(' && '),
      max: requestedMax,
      files: eligible,
      skipped,
    };
  }

  // SLOW FALLBACK. At least one file hollow-test will mutate has no fast,
  // known-correct test command. Guessing "skip it" here is exactly the bug
  // this file exists to fix: hollow-test would mutate it anyway via its own
  // independent scan, and a --test-cmd that never touches it would report a
  // guaranteed false SURVIVED. The only sound fallback is a command broad
  // enough to actually exercise it — the full monorepo suite. Known unsafe in
  // the mutation-gate CI job for files needing live CLI installs that job
  // doesn't provision (see the v3 header note) — narrowing WHICH files reach
  // this path (via testTargetFor's scripts/ mapping) is the mitigation.
  return {
    kind: 'slow',
    testCmd: 'node scripts/run-tests.mjs',
    // The full suite is ~9.5 minutes per run; keep the fallback's mutant budget
    // small regardless of what --max requested, so a slow-path PR still
    // finishes in bounded CI time rather than silently taking hours.
    max: Math.min(requestedMax, 3),
    uncovered,
    skipped,
  };
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

export function main() {
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

  // The base must resolve. `git diff <bad-ref>` fails loudly, but an unfetched
  // base in CI is an operational problem, not "nothing changed" — say so rather
  // than passing an empty diff.
  if (git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status !== 0) {
    fail(`base ref '${base}' does not resolve — fetch it or pass the correct base`);
  }

  const diff = git(['diff', '--name-only', '-z', base, '--']);
  if (diff.status !== 0) fail('git diff failed');
  const changed = diff.stdout.split('\0').filter(Boolean);

  console.log(`mutation-gate: base=${base}`);

  const decision = classify(changed, requestedMax, ROOT);

  // Printed for EVERY outcome. A green run must never leave a reader unable to
  // tell "the gate looked and found nothing" from "the gate did not look".
  if (decision.skipped?.length) {
    console.log(`mutation-gate: ${decision.skipped.length} changed file(s) are not a mutable source type, so this gate does not cover them:`);
    for (const f of decision.skipped) console.log(`  ${f}`);
  }

  if (decision.kind === 'nothing') {
    console.log('mutation-gate: no source files changed — nothing to mutate.');
    process.exit(0);
  }

  if (decision.kind === 'fast') {
    console.log(`mutation-gate: ${decision.files.length} file(s) covered by fast test targets → ${decision.testCmd}`);
  } else {
    console.log(`mutation-gate: ${decision.uncovered.length} file(s) have no known fast test target — falling back to the FULL suite:`);
    for (const f of decision.uncovered) console.log(`  ${f}`);
    console.log(`mutation-gate: capping budget at ${decision.max} mutant(s) for the slow path (requested ${requestedMax})`);
  }

  // NO --target. hollow-test independently re-derives the same file set from
  // the same --base and hunk-scopes each one from the diff itself.
  const bin = join(ROOT, 'packages', 'hollow-test', 'bin', 'hollow-test.mjs');
  const result = spawnSync(process.execPath, [
    bin,
    '--base', base,
    '--test-cmd', decision.testCmd,
    '--max', String(decision.max),
    '--timeout-ms', decision.kind === 'fast' ? '180000' : '600000',
    // Mirror the wrapper's own source declaration into the tool, so the two
    // cannot disagree about the ambiguous product names (see SOURCE_GLOBS).
    ...SOURCE_GLOBS.flatMap((g) => ['--source-glob', g]),
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
}

// Only run main() when executed directly, so the test can import the pure parts.
if (isMain()) {
  main();
}
