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
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnTrial, withHeapCapHint } from '../packages/hollow-test/lib/runner.mjs';
import {
  ROOT,
  MUTANTS_PER_CHANGED_FILE,
  HOLLOW_WINDOW_MS,
  FAST_RUN_TIMEOUT_MS,
  SLOW_RUN_TIMEOUT_MS,
  SURVIVOR_GUIDANCE,
  SOURCE_GLOBS,
  hollowTestWouldMutate,
  testTargetFor,
  mutableChangedFiles,
  classify,
  mutantBudget,
} from '../packages/hollow-test/lib/gate-plan.mjs';

export {
  ROOT,
  MUTANTS_PER_CHANGED_FILE,
  HOLLOW_WINDOW_MS,
  FAST_RUN_TIMEOUT_MS,
  SLOW_RUN_TIMEOUT_MS,
  SURVIVOR_GUIDANCE,
  SOURCE_GLOBS,
  hollowTestWouldMutate,
  testTargetFor,
  mutableChangedFiles,
  classify,
  mutantBudget,
} from '../packages/hollow-test/lib/gate-plan.mjs';

/**
 * Generated files that scripts/release.mjs rewrites on every lockstep bump. A
 * release changes only their version stamps, which no mutant can exercise, so
 * hollow-test reports them as not covered instead of refusing the release. Only
 * the files listed here qualify; adding one is a change to this gate.
 */
export const GENERATED_VERSION_FILES = [
  'plugins/adlc-cursor/bin/adlc-mcp-wrapper.bundle.mjs',
  'plugins/adlc-cursor/lib/mcp-build-metadata.mjs',
];

/**
 * The wrapper's file declarations, mirrored into hollow-test so the two cannot
 * disagree: the ambiguous product names (SOURCE_GLOBS) and the generated files
 * a release rewrites (GENERATED_VERSION_FILES).
 * @returns {string[]}
 */
export function declarationArgs() {
  return [
    ...SOURCE_GLOBS.flatMap((g) => ['--source-glob', g]),
    ...GENERATED_VERSION_FILES.flatMap((f) => ['--generated', f]),
  ];
}

/**
 * Time ONE run of the fast target command — the same shell command hollow-test will run —
 * so the draw can be sized to what actually fits. A red run is the gate's own baseline
 * failure, reported with the suite's output before any mutant is drawn.
 */
/**
 * The baseline measurement launches exactly the way hollow-test's own trials
 * do, through runner.mjs's spawnTrial (watchdog, heap cap, report). spawnSync's timeout signals its direct child only,
 * and with a bare `shell: true` that child is /bin/sh — `node --test` and its
 * workers kept running after this measurement timed out, the same orphan
 * class the 2026-10-08 incident was made of, on every `npm run preflight`.
 * Injectable: the tests hand in a fake with the same (cmd, args, opts) shape.
 */
function spawnThroughWatchdog(testCmd, _args, { cwd, timeout }) {
  // hollow-test's own launch path, so this measurement and the trials it sizes
  // have identical settings (watchdog, heap cap, report, pipes, and the trial's
  // own maxBuffer — a verbose suite must not die of ENOBUFS here and run fine
  // under hollow-test).
  const r = spawnTrial(testCmd, { cwd, timeoutMs: timeout });
  // A node that died at the cap gets the knob named here as well, not only in a trial.
  return { ...r, stderr: withHeapCapHint({ stderr: r.stderr }, r.hollowCap).stderr };
}

export function measureRun(testCmd, { spawn = spawnThroughWatchdog, now = Date.now, cwd = ROOT, timeoutMs = FAST_RUN_TIMEOUT_MS } = {}) {
  const t0 = now();
  const r = spawn(testCmd, [], { shell: true, cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const runMs = Math.max(1, now() - t0);
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // A real timeout arrives as error ETIMEDOUT (with the SIGTERM spawnSync sent).
  // Every other error — ENOENT, EAGAIN/ENOMEM on a starved host, ENOBUFS — is a
  // launch that did not happen, and must never read as "the suite ran and was
  // killed": that false signal is exactly what runner.mjs's classifyTestResult
  // was split out to prevent.
  if (r.error?.code === 'ETIMEDOUT') return { ok: false, runMs, output, reason: `the fast target command timed out (${timeoutMs} ms) or was killed by ${r.signal ?? 'a signal'}` };
  if (r.error) return { ok: false, runMs, output, reason: `could not run the fast target command: ${r.error.message}` };
  if (r.signal || r.status == null) return { ok: false, runMs, output, reason: `the fast target command timed out (${timeoutMs} ms) or was killed by ${r.signal ?? 'a signal'}` };
  if (r.status !== 0) return { ok: false, runMs, output, reason: `the fast target command exited ${r.status}` };
  return { ok: true, runMs, output };
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
  // Deleted / renamed-away paths have no on-disk post-image to mutate in place,
  // so a deletion-only diff must not fast-path them into hollow-test (#329).
  const changed = mutableChangedFiles(diff.stdout.split('\0').filter(Boolean));

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
  // The draw is sized by what fits the window (T-01M19V5SCKQYRPYXYZHQ0AEZBT): one measured run of
  // the fast target command first — a red one is the baseline failure, reported with its output.
  let budget;
  if (decision.kind === 'fast') {
    const measured = measureRun(decision.testCmd);
    if (!measured.ok) {
      process.stderr.write(measured.output.slice(-8000));
      fail(`${measured.reason} — the baseline suite is not green; fix the suite / the fast target command first`);
    }
    budget = mutantBudget(decision, { runMs: measured.runMs });
    console.log(`mutation-gate: one run of the fast target command took ${(measured.runMs / 1000).toFixed(1)} s; window ${HOLLOW_WINDOW_MS / 60_000} min → ${budget.ok ? `${budget.draw} draw(s)` : 'does not fit'} (wanted ${budget.want} = ${MUTANTS_PER_CHANGED_FILE} × ${decision.files.length} file(s))`);
    if (!budget.ok) fail(`${budget.reason}. Make the fast target command cheaper or split the change.`);
    if (budget.capped) {
      console.log(`mutation-gate: BUDGET-CAPPED — ${budget.draw} of ${budget.want} draws: changed files may receive fewer than ${MUTANTS_PER_CHANGED_FILE} draws each (${decision.files.length} files); per-file coverage is reduced for this diff, not silently skipped.`);
    }
  } else {
    budget = mutantBudget(decision);
  }

  const bin = join(ROOT, 'packages', 'hollow-test', 'bin', 'hollow-test.mjs');
  const result = spawnSync(process.execPath, [
    bin,
    '--base', base,
    '--test-cmd', decision.testCmd,
    // The draw: every changed file gets more than one draw when that fits the window — see
    // mutantBudget: a single draw can be spent on an unparseable mutant, which leaves that
    // file unprosecuted while the run still reports zero survivors. When it does not fit,
    // the cap was printed above; the run is bounded either way.
    '--max', String(budget.draw),
    '--timeout-ms', String(decision.kind === 'fast' ? FAST_RUN_TIMEOUT_MS : SLOW_RUN_TIMEOUT_MS),
    ...declarationArgs(),
  ], { stdio: 'inherit', cwd: ROOT, timeout: HOLLOW_WINDOW_MS + 60_000 });

  if (result.error) fail(`could not run hollow-test: ${result.error.message}`);
  if (result.signal) fail(`hollow-test timed out or was killed by ${result.signal}`);

  if (result.status === 2) {
    console.error('');
    console.error('mutation-gate: a mutant SURVIVED — some changed code has no test that notices it changing.');
    console.error('This is the hollow-test failure mode: a guard can be correct and still be unverified.');
    console.error('Add a test that fails when that line is altered.');
    console.error('');
    for (const line of SURVIVOR_GUIDANCE) console.error(line);
  }
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

// Only run main() when executed directly, so the test can import the pure parts.
if (isMain()) {
  main();
}
