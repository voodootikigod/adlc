// packages/hollow-test/test/gate-plan.test.mjs — unit tests for the pure
// mutation-gate planner (target resolution, diff classification, and mutant budget).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
} from '../lib/gate-plan.mjs';
import { isMutableSource } from '../lib/targets.mjs';
import { generateMutants } from '../../core/lib/mutate.mjs';

const fixtureDirs = new Set();
after(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});

function fixtureRoot(dirs = [], files = []) {
  const root = mkdtempSync(join(tmpdir(), 'gate-plan-fixture-'));
  fixtureDirs.add(root);
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  for (const f of files) writeFileSync(join(root, f), '// fixture\n');
  return root;
}

// ------------------------------------------------------------------- constants

test('ROOT resolves to the repository root three levels above packages/hollow-test/lib', () => {
  assert.equal(typeof ROOT, 'string');
  assert.equal(existsSync(join(ROOT, 'package.json')), true);
  assert.equal(existsSync(join(ROOT, 'packages/hollow-test/lib/gate-plan.mjs')), true);
});

test('timeout and budget constants match the gate contract', () => {
  assert.equal(MUTANTS_PER_CHANGED_FILE, 2);
  assert.ok(MUTANTS_PER_CHANGED_FILE > 1);
  assert.equal(HOLLOW_WINDOW_MS, 45 * 60_000);
  assert.equal(FAST_RUN_TIMEOUT_MS, 180_000);
  assert.equal(SLOW_RUN_TIMEOUT_MS, 600_000);
  assert.deepEqual(SOURCE_GLOBS, ['**/hollow-test.mjs', '**/spec-lint.mjs']);
});

test('SURVIVOR_GUIDANCE is frozen and states that no suppression is supported', () => {
  assert.equal(Object.isFrozen(SURVIVOR_GUIDANCE), true);
  const text = SURVIVOR_GUIDANCE.join(' ');
  assert.ok(!/\bNO comment or annotation that suppresses\b/i.test(text));
  assert.match(text, /no SUPPORTED way to suppress/i);
  const mutants = generateMutants('/* x */ const limit = 3;');
  assert.equal(mutants.length, 1);
  assert.equal(mutants[0].mutated, '/* x */ const limit = 4;');
});

// -------------------------------------------------------- hollowTestWouldMutate

test('hollowTestWouldMutate excludes test/spec paths, case-insensitively', () => {
  assert.equal(hollowTestWouldMutate('packages/foo/lib/x.mjs'), true);
  assert.equal(hollowTestWouldMutate('packages/foo/test/x.test.mjs'), false);
  assert.equal(hollowTestWouldMutate('packages/foo/TEST/x.mjs'), false);
  assert.equal(hollowTestWouldMutate('packages/foo/spec/x.mjs'), false);
});

test('hollowTestWouldMutate does not treat extensionless files or dotfiles as source', () => {
  for (const f of ['CODEOWNERS', 'LICENSE', 'Dockerfile', 'Makefile', 'NOTICE', 'Procfile']) {
    assert.equal(hollowTestWouldMutate(f), false, `${f} is not mutable source`);
  }
  for (const f of ['.gitignore', '.nvmrc', '.npmrc', '.editorconfig', '.gitattributes']) {
    assert.equal(hollowTestWouldMutate(f), false, `${f} is not mutable source`);
  }
});

test('hollowTestWouldMutate admits plain JavaScript and rejects TS, Python, and non-code extensions', () => {
  for (const f of ['a.mjs', 'a.cjs', 'a.js', 'packages/x/lib/y.mjs', 'plugins/p/hooks/h.mjs']) {
    assert.equal(hollowTestWouldMutate(f), true, `${f} is mutable source`);
  }
  for (const f of [
    'a.ts', 'a.mts', 'a.cts', 'a.tsx', 'a.jsx', 'a.py', 'apps/docs/app/page.tsx',
    'src/app.py', 'src/test_app.py', 'src/app_test.py', 'conftest.py',
    'packages/foo/a.md', 'packages/foo/a.json', 'packages/foo/a.yml',
    'packages/foo/a.yaml', 'packages/foo/a.lock', 'packages/foo/a.txt',
    'packages/foo/a.toml', 'packages/foo/a.snap',
  ]) {
    assert.equal(hollowTestWouldMutate(f), false, `${f} must not be mutated`);
  }
});

test('production source is not excluded merely for containing "test"/"spec"', () => {
  for (const f of [
    'packages/hollow-test/lib/targets.mjs',
    'packages/hollow-test/lib/gate-plan.mjs',
    'packages/hollow-test/lib/runner.mjs',
    'packages/hollow-test/bin/hollow-test.mjs',
    'packages/gate-manifest/lib/attest.mjs',
    'packages/spec-lint/lib/parse.mjs',
    'packages/spec-lint/bin/spec-lint.mjs',
    'scripts/run-tests.mjs',
  ]) {
    assert.equal(hollowTestWouldMutate(f), true, `${f} is production source`);
  }
});

test('genuine test/spec directories and conventional test basenames are excluded', () => {
  for (const f of [
    'packages/foo/test/x.mjs',
    'packages/foo/tests/x.mjs',
    'packages/foo/TEST/x.mjs',
    'spec/z.mjs',
    'packages/foo/specs/z.mjs',
    'packages/foo/__tests__/z.mjs',
    'packages/foo/lib/x.test.mjs',
    'packages/foo/lib/x.spec.ts',
    'x.test.mjs',
    'test.js', 'spec.js', 'test.mjs', 'spec.ts',
    'lib/test.js', 'lib/spec.js',
    'test_foo.js', 'spec_foo.js',
    'foo_test.js', 'foo_spec.mjs',
    'foo-test.js', 'test-foo.js', 'spec-foo.js',
  ]) {
    assert.equal(hollowTestWouldMutate(f), false, `${f} is a test file`);
  }
});

test('declared source globs rescue production files that look like tests', () => {
  for (const f of [
    'packages/hollow-test/bin/hollow-test.mjs',
    'packages/spec-lint/bin/spec-lint.mjs',
  ]) {
    assert.equal(hollowTestWouldMutate(f), true, `${f} is declared production source`);
    assert.equal(isMutableSource(f), false, `${f} is ambiguous without a declaration`);
  }
});

test('hollowTestWouldMutate agrees with isMutableSource across non-ambiguous paths', () => {
  const cases = [
    'a.mjs', 'a.cjs', 'a.js', 'a.jsx', 'a.ts', 'a.mts', 'a.cts', 'a.tsx',
    'packages/x/lib/y.mjs', 'apps/docs/app/page.tsx', 'plugins/p/index.ts',
    'CODEOWNERS', 'LICENSE', 'Dockerfile', 'Makefile', '.gitignore', '.nvmrc',
    'README.md', 'package.json', 'a.yml', 'a.lock', 'a.snap',
    'packages/x/test/y.test.mjs', 'spec/z.mjs',
  ];
  for (const f of cases) {
    assert.equal(hollowTestWouldMutate(f), isMutableSource(f), f);
  }
});

// -------------------------------------------------------------- testTargetFor

test('testTargetFor maps packages/ sources across test/, cli-test/, and adapter-test/', () => {
  const onlyTest = fixtureRoot(['packages/foo/test']);
  assert.equal(testTargetFor('packages/foo/lib/x.mjs', onlyTest), 'packages/foo/test/*.test.mjs');

  const testAndCli = fixtureRoot(['packages/foo/test', 'packages/foo/cli-test']);
  assert.equal(
    testTargetFor('packages/foo/lib/x.mjs', testAndCli),
    'packages/foo/test/*.test.mjs packages/foo/cli-test/*.test.mjs',
  );

  const onlyCli = fixtureRoot(['packages/foo/cli-test']);
  assert.equal(testTargetFor('packages/foo/lib/x.mjs', onlyCli), 'packages/foo/cli-test/*.test.mjs');

  const allThree = fixtureRoot(['packages/foo/test', 'packages/foo/cli-test', 'packages/foo/adapter-test']);
  assert.equal(
    testTargetFor('packages/foo/lib/x.mjs', allThree),
    'packages/foo/test/*.test.mjs packages/foo/cli-test/*.test.mjs packages/foo/adapter-test/*.test.mjs',
  );

  const onlyAdapter = fixtureRoot(['packages/foo/adapter-test']);
  assert.equal(testTargetFor('packages/foo/lib/x.mjs', onlyAdapter), 'packages/foo/adapter-test/*.test.mjs');

  const none = fixtureRoot(['packages/foo/lib']);
  assert.equal(testTargetFor('packages/foo/lib/x.mjs', none), null);
});

test('testTargetFor maps apps/<x>/ source to its test directory glob or null when absent', () => {
  const withTest = fixtureRoot(['apps/docs/test']);
  assert.equal(testTargetFor('apps/docs/lib/x.mjs', withTest), 'apps/docs/test/*.test.mjs');

  const withoutTest = fixtureRoot(['apps/docs/lib']);
  assert.equal(testTargetFor('apps/docs/lib/x.mjs', withoutTest), null);
});

test('testTargetFor maps plugins/<x>/hooks|lib|agents|mcp and unions with plugin-root test/', () => {
  const subOnly = fixtureRoot(['plugins/adlc-codex/hooks/test', 'plugins/adlc-codex/lib/test']);
  assert.equal(testTargetFor('plugins/adlc-codex/hooks/x.mjs', subOnly), 'plugins/adlc-codex/hooks/test/*.test.mjs');
  assert.equal(testTargetFor('plugins/adlc-codex/lib/x.mjs', subOnly), 'plugins/adlc-codex/lib/test/*.test.mjs');
  assert.equal(testTargetFor('plugins/adlc-codex/agents/x.mjs', subOnly), null);

  const both = fixtureRoot(['plugins/adlc-copilot/hooks/test', 'plugins/adlc-copilot/test']);
  assert.equal(
    testTargetFor('plugins/adlc-copilot/hooks/x.mjs', both),
    'plugins/adlc-copilot/hooks/test/*.test.mjs plugins/adlc-copilot/test/*.test.mjs',
  );

  const pluginRootOnly = fixtureRoot(['plugins/adlc-copilot/test']);
  assert.equal(
    testTargetFor('plugins/adlc-copilot/mcp/x.mjs', pluginRootOnly),
    'plugins/adlc-copilot/test/*.test.mjs',
  );
});

test('testTargetFor maps top-level plugins/<x>/ source to its test directory glob or null', () => {
  const withTest = fixtureRoot(['plugins/adlc-cursor/test']);
  assert.equal(testTargetFor('plugins/adlc-cursor/rails-checker.mjs', withTest), 'plugins/adlc-cursor/test/*.test.mjs');

  const withoutTest = fixtureRoot(['plugins/adlc-cursor']);
  assert.equal(testTargetFor('plugins/adlc-cursor/rails-checker.mjs', withoutTest), null);
});

test('testTargetFor maps scripts/<name>.mjs to scripts/test/<name>.test.mjs when it exists', () => {
  const root = fixtureRoot(['scripts/test'], ['scripts/test/mutation-gate.test.mjs']);
  assert.equal(testTargetFor('scripts/mutation-gate.mjs', root), 'scripts/test/mutation-gate.test.mjs');
  assert.equal(testTargetFor('scripts/no-test-for-this.mjs', root), null);
});

test('testTargetFor maps EXACT script paths when their target test exists and returns null when absent', () => {
  const present = fixtureRoot(
    ['scripts/test'],
    [
      'scripts/test/ticket-reader-generation.test.mjs',
      'scripts/test/router-drift.test.mjs',
      'scripts/test/smoke-teardown.test.mjs',
    ],
  );
  assert.equal(
    testTargetFor('scripts/ticket-readers/generate.mjs', present),
    'scripts/test/ticket-reader-generation.test.mjs',
  );
  assert.equal(testTargetFor('scripts/ticket-readers/read-only-loader.mjs', present), null);
  assert.equal(
    testTargetFor('scripts/router/router-model.mjs', present),
    'scripts/test/router-drift.test.mjs',
  );
  assert.equal(
    testTargetFor('scripts/codex-install-smoke.mjs', present),
    'scripts/test/smoke-teardown.test.mjs',
  );
  assert.equal(
    testTargetFor('scripts/gemini-install-smoke.mjs', present),
    'scripts/test/smoke-teardown.test.mjs',
  );

  const absent = fixtureRoot(['scripts/test']);
  assert.equal(testTargetFor('scripts/ticket-readers/generate.mjs', absent), null);
  assert.equal(testTargetFor('scripts/router/router-model.mjs', absent), null);
  assert.equal(testTargetFor('scripts/codex-install-smoke.mjs', absent), null);
  assert.equal(testTargetFor('scripts/gemini-install-smoke.mjs', absent), null);
});

test('testTargetFor maps scripts/pi-live-deny.mjs to plugins/adlc-pi/test/*.test.mjs only when that dir exists', () => {
  const present = fixtureRoot(['plugins/adlc-pi/test']);
  assert.equal(testTargetFor('scripts/pi-live-deny.mjs', present), 'plugins/adlc-pi/test/*.test.mjs');
  assert.equal(testTargetFor('scripts/pi-other.mjs', present), null);

  const absent = fixtureRoot([]);
  assert.equal(testTargetFor('scripts/pi-live-deny.mjs', absent), null);
});

test('testTargetFor maps a nested scripts/ source only when its basename is unique outside scripts/test', () => {
  const unique = fixtureRoot(
    ['scripts/router', 'scripts/other', 'scripts/test'],
    [
      'scripts/router/check-consolidation.mjs',
      'scripts/other/unrelated.mjs',
      'scripts/other/also-unrelated.mjs',
      'scripts/test/check-consolidation.mjs',
      'scripts/test/check-consolidation.test.mjs',
    ],
  );
  assert.equal(
    testTargetFor('scripts/router/check-consolidation.mjs', unique),
    'scripts/test/check-consolidation.test.mjs',
  );

  const collidesWithTopLevel = fixtureRoot(
    ['scripts/sub', 'scripts/test'],
    ['scripts/mutation-gate.mjs', 'scripts/sub/mutation-gate.mjs', 'scripts/test/mutation-gate.test.mjs'],
  );
  assert.equal(testTargetFor('scripts/sub/mutation-gate.mjs', collidesWithTopLevel), null);
  assert.equal(
    testTargetFor('scripts/mutation-gate.mjs', collidesWithTopLevel),
    'scripts/test/mutation-gate.test.mjs',
  );

  const collidesNested = fixtureRoot(
    ['scripts/a', 'scripts/b', 'scripts/test'],
    ['scripts/a/dup.mjs', 'scripts/b/dup.mjs', 'scripts/test/dup.test.mjs'],
  );
  assert.equal(testTargetFor('scripts/a/dup.mjs', collidesNested), null);
  assert.equal(testTargetFor('scripts/b/dup.mjs', collidesNested), null);

  const missingTest = fixtureRoot(['scripts/router', 'scripts/test'], ['scripts/router/no-coverage.mjs']);
  assert.equal(testTargetFor('scripts/router/no-coverage.mjs', missingTest), null);

  const missingScriptsDir = fixtureRoot([]);
  assert.equal(testTargetFor('scripts/sub/mutation-gate.mjs', missingScriptsDir), null);
  assert.equal(testTargetFor('README.md', missingScriptsDir), null);
});

test('testTargetFor defaults root to ROOT when omitted', () => {
  assert.equal(
    testTargetFor('packages/hollow-test/lib/gate-plan.mjs'),
    'packages/hollow-test/test/*.test.mjs',
  );
});

// --------------------------------------------------------- mutableChangedFiles

test('mutableChangedFiles keeps only paths present on disk under root and defaults root to ROOT', () => {
  const root = fixtureRoot(['pkg/lib'], ['pkg/lib/present.mjs']);
  assert.deepEqual(
    mutableChangedFiles(['pkg/lib/present.mjs', 'pkg/lib/deleted.mjs'], root),
    ['pkg/lib/present.mjs'],
  );
  assert.deepEqual(
    mutableChangedFiles(['packages/hollow-test/lib/gate-plan.mjs', 'packages/hollow-test/lib/does-not-exist.mjs']),
    ['packages/hollow-test/lib/gate-plan.mjs'],
  );
});

// -------------------------------------------------------------------- classify

test('classify reports nothing and skipped files when no eligible source files changed', () => {
  const root = fixtureRoot([]);
  assert.deepEqual(classify([], 12, root), { kind: 'nothing', skipped: [] });
  assert.deepEqual(classify(['README.md', 'packages/foo/test/x.test.mjs', 'apps/docs/app/global.css'], 12, root), {
    kind: 'nothing',
    skipped: ['README.md', 'packages/foo/test/x.test.mjs', 'apps/docs/app/global.css'],
  });
});

test('classify takes the fast path when all eligible files map to targets, sorting and deduplicating targets', () => {
  const root = fixtureRoot(['packages/foo/test', 'packages/bar/test']);
  const result = classify(
    ['packages/foo/lib/x.mjs', 'packages/foo/lib/y.mjs', 'packages/bar/lib/z.mjs', 'apps/docs/app/global.css'],
    12,
    root,
  );
  assert.deepEqual(result, {
    kind: 'fast',
    testCmd: 'node --test packages/bar/test/*.test.mjs && node --test packages/foo/test/*.test.mjs',
    max: 12,
    files: ['packages/foo/lib/x.mjs', 'packages/foo/lib/y.mjs', 'packages/bar/lib/z.mjs'],
    skipped: ['apps/docs/app/global.css'],
  });
});

test('classify falls back to the slow path when any eligible file is unmapped and caps max at 3', () => {
  const root = fixtureRoot(['packages/foo/test']);
  const capped = classify(['packages/foo/lib/x.mjs', 'scripts/uncovered.mjs', 'README.md'], 50, root);
  assert.deepEqual(capped, {
    kind: 'slow',
    testCmd: 'node scripts/run-tests.mjs',
    max: 3,
    uncovered: ['scripts/uncovered.mjs'],
    skipped: ['README.md'],
  });

  const smallMax = classify(['scripts/uncovered.mjs'], 1, root);
  assert.equal(smallMax.kind, 'slow');
  assert.equal(smallMax.max, 1);
});

test('classify defaults root to ROOT and covers gate-plan.mjs and mutation-gate.mjs on the fast path', () => {
  const planDecision = classify(['packages/hollow-test/lib/gate-plan.mjs'], 12);
  assert.equal(planDecision.kind, 'fast');
  assert.equal(planDecision.testCmd, 'node --test packages/hollow-test/test/*.test.mjs');

  const scriptDecision = classify(['scripts/mutation-gate.mjs'], 12);
  assert.equal(scriptDecision.kind, 'fast');
  assert.equal(scriptDecision.testCmd, 'node --test scripts/test/mutation-gate.test.mjs');
});

// ---------------------------------------------------------------- mutantBudget

const fast = (n, max = 12) => ({
  kind: 'fast',
  max,
  files: Array.from({ length: n }, (_, i) => `packages/x/lib/f${i}.mjs`),
  testCmd: 'node --test packages/x/test/*.test.mjs',
});

test('mutantBudget handles slow path and unmeasured fast path', () => {
  assert.deepEqual(
    mutantBudget({ kind: 'slow', max: 3, files: Array.from({ length: 16 }, (_, i) => `src/f${i}.mjs`) }),
    { ok: true, draw: 3, want: 3, fits: null, capped: false },
  );
  assert.deepEqual(
    mutantBudget({ kind: 'fast', max: 12 }),
    { ok: true, draw: 12, want: 12, fits: null, capped: false },
  );
  assert.deepEqual(
    mutantBudget(fast(3)),
    { ok: true, draw: 12, want: 12, fits: null, capped: false },
  );
  assert.deepEqual(
    mutantBudget(fast(20)),
    { ok: true, draw: 40, want: 40, fits: null, capped: false },
  );
});

test('mutantBudget sizes measured fast draws within the window and respects per-run timeout and floor boundaries', () => {
  // Fits uncapped
  const small = mutantBudget(fast(5), { runMs: 80_000, windowMs: 45 * 60_000 });
  assert.deepEqual(small, { ok: true, draw: 12, want: 12, fits: 32, capped: false });

  // Fits exact want (draw === want -> capped: false)
  const exactWant = mutantBudget(fast(16), { runMs: 80_000, windowMs: 45 * 60_000 });
  assert.deepEqual(exactWant, { ok: true, draw: 32, want: 32, fits: 32, capped: false });

  // Capped between floor and want
  const big = mutantBudget(fast(67), { runMs: 80_000, windowMs: 45 * 60_000 });
  assert.deepEqual(big, { ok: true, draw: 32, want: 134, fits: 32, capped: true });

  // Floor fits exactly (fits === decision.max)
  const exactFloor = mutantBudget(fast(67), { runMs: 120_000, windowMs: 13 * 120_000 });
  assert.deepEqual(exactFloor, { ok: true, draw: 12, want: 134, fits: 12, capped: true });

  // Run cost equals perRunTimeoutMs exactly (allowed, not > perRunTimeoutMs)
  const atTimeout = mutantBudget(fast(3), { runMs: FAST_RUN_TIMEOUT_MS, windowMs: HOLLOW_WINDOW_MS });
  assert.deepEqual(atTimeout, { ok: true, draw: 12, want: 12, fits: 14, capped: false });

  // Run cost exceeds perRunTimeoutMs by 1 ms
  const overTimeout = mutantBudget(fast(3), { runMs: FAST_RUN_TIMEOUT_MS + 1, windowMs: HOLLOW_WINDOW_MS });
  assert.deepEqual(overTimeout, {
    ok: false,
    draw: 0,
    want: 12,
    fits: 0,
    capped: true,
    reason: `one run of the fast target command takes ${FAST_RUN_TIMEOUT_MS + 1} ms, past the ${FAST_RUN_TIMEOUT_MS} ms per-run timeout hollow-test is handed — every run would time out`,
  });

  // Fewer draws fit than the requested floor
  const belowFloor = mutantBudget(fast(67), { runMs: 120_000, windowMs: 1_400_000 });
  assert.deepEqual(belowFloor, {
    ok: false,
    draw: 0,
    want: 134,
    fits: 10,
    capped: true,
    reason: 'one run of the fast target command takes 120000 ms; 10 draw(s) fit the 1400000 ms window after the baseline, fewer than the requested floor of 12',
  });

  // Window cannot even hold baseline + 1 draw -> fits clamped to 0, never negative or 1
  const tiny = mutantBudget(fast(3), { runMs: 100_000, windowMs: 50_000 });
  assert.equal(tiny.ok, false);
  assert.equal(tiny.fits, 0);
  assert.equal(tiny.draw, 0);
  assert.equal(tiny.capped, true);
  assert.match(tiny.reason, /0 draw\(s\) fit/);
});
