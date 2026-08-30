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
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMutableSource } from '../packages/hollow-test/lib/targets.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');


/**
 * Every source under scripts/** whose basename is `base`, excluding the test
 * tree. Used to refuse the same-basename mapping when it would be ambiguous —
 * see testTargetFor. Walks the tree rather than consulting git so it stays
 * unit-testable against a fixture root.
 */
function sourcesNamed(base, root) {
  const out = [];
  const walk = (relDir) => {
    let entries;
    try { entries = readdirSync(join(root, relDir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relDir === '' ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (rel === 'scripts/test') continue; // tests are not sources
        walk(rel);
      } else if (/\.(?:mjs|cjs|js)$/.test(e.name) && e.name.replace(/\.(?:mjs|cjs|js)$/, '') === base) {
        out.push(rel);
      }
    }
  };
  walk('scripts');
  return out;
}

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
    const globs = [];
    const testDir = `packages/${m[1]}/test`;
    const cliTestDir = `packages/${m[1]}/cli-test`;
    const adapterTestDir = `packages/${m[1]}/adapter-test`;
    if (existsSync(join(root, testDir))) globs.push(`${testDir}/*.test.mjs`);
    // CLI contract suites may live outside test/ so they do not match a frozen
    // `test/**/*.test.mjs` rail from an earlier ticket (T154 / context-handoff).
    if (existsSync(join(root, cliTestDir))) globs.push(`${cliTestDir}/*.test.mjs`);
    // Same reason, same convention: adapter-contract suites (context-handoff's
    // own adapter-core.test.mjs, recovery-exception.test.mjs, and every
    // relocation this pattern has accumulated since) also live outside test/
    // to route around the same frozen rail. Without this, mutation-gate's
    // auto-derived --test-cmd silently omits coverage that genuinely exists,
    // reporting a false SURVIVED for every mutant only an adapter-test/ suite
    // kills.
    if (existsSync(join(root, adapterTestDir))) globs.push(`${adapterTestDir}/*.test.mjs`);
    return globs.length > 0 ? globs.join(' ') : null;
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
  if ((m = /^scripts\/(?:.+\/)?([^/]+)\.(?:mjs|cjs|js)$/.exec(file))) {
    const base = m[1];
    // An EXACT-path mapping, for a source whose tests are named after what they
    // assert rather than after the file. It precedes the basename convention
    // below because it does not depend on it: naming one file's test outright
    // says nothing about how many other files share its basename. Without this,
    // the generator has no fast target, the whole run drops to the slow path,
    // and that path's budget cap is 3 mutants for the ENTIRE diff — so touching
    // the generator silently stops prosecuting everything changed beside it.
    const EXACT = {
      'scripts/ticket-readers/generate.mjs': 'scripts/test/ticket-reader-generation.test.mjs',
      // router-model.mjs is named for what it declares, not for what asserts
      // it (no scripts/test/router-model.test.mjs) — router-drift.test.mjs is
      // what actually exercises it (drift = generateAll(model) vs committed
      // routers). Without this, the file has no fast target and the whole run
      // drops to the slow path, whose budget cap (3 mutants) is spent across
      // the ENTIRE diff.
      'scripts/router/router-model.mjs': 'scripts/test/router-drift.test.mjs',
    };
    if (EXACT[file] && existsSync(join(root, EXACT[file]))) return EXACT[file];
    // A NESTED source may use the same-basename convention only when that
    // basename identifies exactly one source under scripts/**. Two files
    // sharing a name are still different files, and handing one the other's
    // test claims coverage that does not exist — the "gate reports green by
    // not looking" failure this file exists to prevent. Ambiguity therefore
    // maps to nothing and falls through to the slow path: under-claiming
    // coverage is safe, over-claiming is the bug.
    if (file !== `scripts/${base}.mjs` && sourcesNamed(base, root).length !== 1) return null;
    const f = `scripts/test/${base}.test.mjs`;
    if (existsSync(join(root, f))) return f;
    if (base === 'pi-live-deny' && existsSync(join(root, 'plugins/adlc-pi/test'))) return 'plugins/adlc-pi/test/*.test.mjs';
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
 * From a raw `git diff --name-only` set, keep only paths still present on disk
 * under `root`. A deletion (or a rename's OLD path) has no post-image, and
 * hollow-test mutates files IN PLACE — so a removed file is not a mutation
 * target. Filtering it here keeps a deletion-only diff from fast-pathing the
 * removed file into hollow-test, which would then hard-fail with "nothing to
 * mutate" (exit 1) on every dead-code-removal PR (#329). classify() stays pure
 * over path strings and is unaffected; this is the git-diff-boundary filter.
 *
 * @param {string[]} changed  repo-relative paths from the diff
 * @param {string} [root]  repo root, for the existsSync check (fixture-testable)
 * @returns {string[]} the subset that still exists on disk
 */
export function mutableChangedFiles(changed, root = ROOT) {
  return changed.filter((f) => existsSync(join(root, f)));
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

/**
 * Mutants to ask hollow-test for, given a classification (#531).
 *
 * ONE per changed file is not enough. A file's allocation can be spent on a
 * mutant that does not parse — `null-return` on `return {` opening a multi-line
 * object literal is the reliable case — and hollow-test correctly discards that
 * as INVALID rather than counting it as a kill. With a single draw the file then
 * gets NO prosecution at all, while the run reports zero survivors and fails on
 * coverage instead. Seen on #395/PR #530: `Total: 16  Killed: 15  Survived: 0
 * Invalid: 1`, where the one invalid draw was that file's whole budget.
 *
 * Two per file means a single unparseable draw still leaves a real one. It does
 * not make the INVALID path unreachable — that safety net stays, and stays
 * tested in @adlc/hollow-test — it just stops a wide diff from hitting it by
 * budget starvation rather than by a genuinely unmutatable file.
 *
 * The SLOW path keeps its deliberate cap: it re-runs the whole ~9.5-minute suite
 * per mutant, so widening there trades a bounded CI job for an unbounded one.
 */
export const MUTANTS_PER_CHANGED_FILE = 2;

/** The ONE spawnSync window hollow-test gets: its baseline run plus every mutant run must fit. */
export const HOLLOW_WINDOW_MS = 45 * 60_000;
/** Per-run timeout hollow-test is handed on the fast path (the slow path keeps its own 10 minutes). */
export const FAST_RUN_TIMEOUT_MS = 180_000;
export const SLOW_RUN_TIMEOUT_MS = 600_000;

/**
 * Size the hollow-test draw. Without a measurement this is exactly the historical rule
 * (every changed file gets more than one draw; a bare-minimum `max` otherwise). WITH a
 * measured run cost the draw is the largest that fits the window — hollow-test runs the
 * suite once as a baseline and once per mutant — never above 2 × files and never below
 * the requested floor. A floor that cannot fit is `ok:false` with the reason: a draw that
 * cannot finish is not coverage, it is a guaranteed ETIMEDOUT (PR #913: 67 files × 2 at
 * ~80 s a run inside a 30-minute window). `capped` says per-file coverage was reduced.
 *
 * @returns {{ ok: boolean, draw: number, want: number, fits: number|null, capped: boolean, reason?: string }}
 */
export function mutantBudget(decision, { runMs = null, windowMs = HOLLOW_WINDOW_MS, perRunTimeoutMs = FAST_RUN_TIMEOUT_MS } = {}) {
  const files = decision.files ?? [];
  if (decision.kind === 'slow') return { ok: true, draw: decision.max, want: decision.max, fits: null, capped: false };
  const want = Math.max(decision.max, files.length * MUTANTS_PER_CHANGED_FILE);
  if (runMs == null) return { ok: true, draw: want, want, fits: null, capped: false };
  if (runMs > perRunTimeoutMs) {
    return { ok: false, draw: 0, want, fits: 0, capped: true, reason: `one run of the fast target command takes ${runMs} ms, past the ${perRunTimeoutMs} ms per-run timeout hollow-test is handed — every run would time out` };
  }
  const fits = Math.max(0, Math.floor(windowMs / runMs) - 1); // minus the baseline run
  if (fits < decision.max) {
    return { ok: false, draw: 0, want, fits, capped: true, reason: `one run of the fast target command takes ${runMs} ms; ${fits} draw(s) fit the ${windowMs} ms window after the baseline, fewer than the requested floor of ${decision.max}` };
  }
  const draw = Math.min(want, fits);
  return { ok: true, draw, want, fits, capped: draw < want };
}

/**
 * Time ONE run of the fast target command — the same shell command hollow-test will run —
 * so the draw can be sized to what actually fits. A red run is the gate's own baseline
 * failure, reported with the suite's output before any mutant is drawn.
 */
export function measureRun(testCmd, { spawn = spawnSync, now = Date.now, cwd = ROOT, timeoutMs = FAST_RUN_TIMEOUT_MS } = {}) {
  const t0 = now();
  const r = spawn(testCmd, [], { shell: true, cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const runMs = Math.max(1, now() - t0);
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
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
    // Mirror the wrapper's own source declaration into the tool, so the two
    // cannot disagree about the ambiguous product names (see SOURCE_GLOBS).
    ...SOURCE_GLOBS.flatMap((g) => ['--source-glob', g]),
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

/**
 * What an author should do about a surviving mutant.
 *
 * This used to assert "There is NO comment or annotation that suppresses this
 * gate — do not go looking for one." That was FALSE (#372 defect 4): mutate.mjs's
 * SKIP_LINE skipped any line beginning with `/*`, so a one-line comment prefix
 * silenced every operator on that line. #372 closed the bypass, and the wording
 * here is now the claim the code can actually keep — no SUPPORTED suppression —
 * rather than an absolute that a future skip rule would quietly falsify again.
 *
 * Exported so the test can assert the claim, not the prose.
 */
export const SURVIVOR_GUIDANCE = Object.freeze([
  'There is no SUPPORTED way to suppress this gate for one line — no annotation, pragma, or',
  'comment marker is honoured, and do not add a test that merely asserts the source text says',
  'what it says (that is a hollow test bolted on to placate the hollow-test gate). If the mutant',
  'is genuinely EQUIVALENT — no test could ever observe the difference, e.g. one extra millisecond',
  'on a subprocess timeout — then generating it is a mutation-OPERATOR bug: fix the operator so it',
  'is never produced, and say why at its definition; the off-by-one tuning-constant mask in',
  '@adlc/core is the worked example.',
]);

// Only run main() when executed directly, so the test can import the pure parts.
if (isMain()) {
  main();
}
