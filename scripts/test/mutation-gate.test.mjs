// scripts/test/mutation-gate.test.mjs — coverage for the mutation-gate wrapper's
// classification logic (v3). Written after the wrapper failed on its OWN
// PR (#260): scripts/mutation-gate.mjs had zero test coverage, so the mutation
// gate's slow fallback tried to verify it via the full monorepo suite, which
// needs live CLI installs (codex/opencode/pi) the mutation-gate CI job doesn't
// provision. This file is exactly what closes that gap — see this repo's own
// same-basename convention (scripts/foo.mjs <-> scripts/test/foo.test.mjs)
// used by release.mjs, ceremony-drift.mjs, and now this file itself.
//
// Fast and self-contained: no git repo, no subprocess, no live network. The
// pure classify()/testTargetFor()/hollowTestWouldMutate() functions are
// exercised directly with a synthetic fixture root.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { testTargetFor, hollowTestWouldMutate, classify } from '../mutation-gate.mjs';
import { isMutableSource } from '../../packages/hollow-test/lib/targets.mjs';

function fixtureRoot(dirs = [], files = []) {
  const root = mkdtempSync(join(tmpdir(), 'mutation-gate-fixture-'));
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  for (const f of files) writeFileSync(join(root, f), '// fixture\n');
  return root;
}

// -------------------------------------------------------------- hollowTestWouldMutate

test('hollowTestWouldMutate excludes test/spec paths, case-insensitively', () => {
  assert.equal(hollowTestWouldMutate('packages/foo/lib/x.mjs'), true);
  assert.equal(hollowTestWouldMutate('packages/foo/test/x.test.mjs'), false);
  assert.equal(hollowTestWouldMutate('packages/foo/TEST/x.mjs'), false);
  assert.equal(hollowTestWouldMutate('packages/foo/spec/x.mjs'), false);
});

// REGRESSION (PR #287). The classifier decided what was source by EXCLUDING a
// fixed list of non-source extensions, so anything with no extension fell
// through and was treated as mutable code. Adding a CODEOWNERS file was enough
// to push the gate onto the FULL-suite slow path:
//
//   mutation-gate: 1 file(s) have no known fast test target —
//   falling back to the FULL suite:
//     CODEOWNERS
//
// hollow-test can only mutate JS-family source, and the gate's own workflow step
// already filters '*.mjs' '*.js' '*.cjs' — the script and the workflow disagreed
// about what source is. An exclusion list is unbounded by construction: every
// extensionless file anyone ever adds is a new false positive.
test('hollowTestWouldMutate does not treat extensionless files as source', () => {
  for (const f of ['CODEOWNERS', 'LICENSE', 'Dockerfile', 'Makefile', 'NOTICE', 'Procfile']) {
    assert.equal(hollowTestWouldMutate(f), false, `${f} is not mutable source`);
  }
});

test('hollowTestWouldMutate does not treat dotfiles as source', () => {
  for (const f of ['.gitignore', '.nvmrc', '.npmrc', '.editorconfig', '.gitattributes']) {
    assert.equal(hollowTestWouldMutate(f), false, `${f} is not mutable source`);
  }
});

// The include-list must still admit everything hollow-test genuinely mutates,
// or the fix trades false positives for the far worse failure: source silently
// skipped by the coverage gate.
//
// This is not hypothetical — the first attempt at this fix narrowed to
// mjs|cjs|js and silently dropped the repository's 49 tracked non-test .ts/.tsx
// source files. hollow-test's own filterTargetFiles accepts them, so classify()
// returned kind:'nothing' and the required gate exited 0 without running.
// Caught by adversarial review, not by the tests written alongside that fix,
// because those tests only asserted the extensions the fix happened to allow.
// It must ALSO admit nothing more. An extension the operators cannot handle
// produces INVALID mutants, and runner.mjs scores `killed = timedOut ||
// status !== 0` — so a parse failure is credited as a kill. `invert-comparison`
// rewrites `Promise<unknown>` to `Promise>=unknown>` and `<Button>` to
// `>=Button>`; with the common per-file quota of one, that single invalid mutant
// satisfies the entire gate having exercised no assertion.
//
// Both directions were learned the hard way here: narrowing to mjs|cjs|js first
// dropped 49 .ts/.tsx files while hollow-test still accepted them, then adding
// TS back admitted the invalid-mutant path. Plain JavaScript only — and the
// exclusion is REPORTED (see the skipped-files tests), which is the difference
// between a documented coverage boundary and a hole. Tracked in #293.
test('the allow-list admits plain JavaScript and nothing the operators cannot handle', () => {
  for (const f of ['a.mjs', 'a.cjs', 'a.js', 'packages/x/lib/y.mjs', 'plugins/p/hooks/h.mjs']) {
    assert.equal(hollowTestWouldMutate(f), true, `${f} is mutable source`);
  }
  for (const f of ['a.ts', 'a.mts', 'a.cts', 'a.tsx', 'a.jsx', 'a.py', 'apps/docs/app/page.tsx']) {
    assert.equal(hollowTestWouldMutate(f), false, `${f} needs syntax-aware mutation (#293)`);
  }
});

// REGRESSION: the test/spec exclusion was a SUBSTRING match over the whole path
// (`/(?:test|spec)/i`), with no segment or filename boundary. Real production
// source whose path merely contains those letters was therefore classified as
// non-source and silently never mutated — 11 tracked files at the time this was
// found, including the ENTIRE hollow-test package (the mutation tool itself),
// the entire spec-lint package, and gate-manifest's attestation module:
//
//   packages/hollow-test/lib/targets.mjs     "hollow-test"
//   packages/gate-manifest/lib/attest.mjs    "attest"
//   packages/spec-lint/lib/parse.mjs         "spec-lint"
//   scripts/run-tests.mjs                    "run-tests"
//
// This is the worst direction of failure: the coverage gate reports green by
// not looking. It also hid itself — a change to targets.mjs could not be
// mutated, so the predicate defining what gets mutated was exempt from the gate
// that uses it.
test('production source is not excluded merely for containing "test"/"spec"', () => {
  for (const f of [
    'packages/hollow-test/lib/targets.mjs',
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

// The boundary must still exclude genuine tests, or the fix swaps one silent
// failure for mutating test files themselves.
test('genuine test and spec paths are still excluded', () => {
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
  ]) {
    assert.equal(hollowTestWouldMutate(f), false, `${f} is a test path`);
  }
});

// Replacing the substring match with directory + dotted-filename rules alone
// admitted common JS test basenames — `test.js`, `spec.js`, `test_foo.js`,
// `foo_test.js`. Mutating an assertion inside a test makes that test fail, which
// scores the mutant KILLED: a test-only diff satisfies the gate vacuously.
test('conventional test basenames are excluded even outside a test/ directory', () => {
  for (const f of [
    'test.js', 'spec.js', 'test.mjs', 'spec.ts',
    'lib/test.js', 'lib/spec.js',
    'test_foo.js', 'spec_foo.js',
    'foo_test.js', 'foo_spec.mjs',
  ]) {
    assert.equal(hollowTestWouldMutate(f), false, `${f} is a test file`);
  }
});

// Hyphenated names ARE test conventions: `node --test` discovers `*-test.js` and
// `test-*.js` by default, and this tool's own examples use that runner. An
// earlier revision on this branch treated them as merely stylistic and admitted
// them as source, which let a test-only diff pass by mutating its OWN
// assertions — flipping `true` to `false` fails the changed test, and that
// failure is credited as a killed production mutant.
test('node --test naming conventions are excluded by default', () => {
  for (const f of ['foo-test.js', 'test-foo.js', 'foo_test.mjs', 'test.js', 'spec-foo.js']) {
    assert.equal(hollowTestWouldMutate(f), false, `${f} matches a node --test convention`);
  }
});

// The genuine ambiguity is with PRODUCT names — `hollow-test.mjs` and
// `spec-lint.mjs` are production source here. No convention can resolve that, so
// the project declares it rather than the tool guessing. The second assertion is
// the load-bearing one: it proves the declaration is doing the work, not a
// lenient default.
test('declared source globs rescue production files that look like tests', () => {
  for (const f of [
    'packages/hollow-test/bin/hollow-test.mjs',
    'packages/spec-lint/bin/spec-lint.mjs',
  ]) {
    assert.equal(hollowTestWouldMutate(f), true, `${f} is declared production source`);
    assert.equal(isMutableSource(f), false, `${f} is ambiguous without a declaration`);
  }
});

// classify()-level proof, and the self-referential one that matters most: a diff
// touching only the predicate's own file must reach the gate.
test('a diff touching only the predicate file still reaches the mutation gate', () => {
  const decision = classify(['packages/hollow-test/lib/targets.mjs'], 12);
  assert.notEqual(
    decision.kind,
    'nothing',
    'the file defining what gets mutated must not be exempt from mutation'
  );
});

// A green gate must never be a SILENT green. Adversarial review flagged that a
// CSS-only diff now yields kind:'nothing' and exit 0, exempting a production
// change from the required gate without saying so.
//
// The answer is NOT to add .css to the source set. The shared mutator is
// regex-based with JS-shaped operators, and on CSS it emits both nonsense
// (`html > body` → `html <= body`) and one genuinely behavioural mutant
// (`opacity: 0` → `opacity: 1`) that NO test in this repository could kill —
// there are no CSS tests. Admitting CSS would make the required gate
// permanently red on any stylesheet change, which is worse than not covering it.
//
// What was wrong is the silence. classify() now reports what it skipped, so
// "this gate does not cover that file type" is a visible decision rather than
// an invisible hole.
test('classify reports files it skipped rather than silently passing', () => {
  const decision = classify(['apps/docs/app/global.css'], 12);
  assert.equal(decision.kind, 'nothing');
  assert.deepEqual(decision.skipped, ['apps/docs/app/global.css']);
});

test('classify reports nothing skipped when the diff is genuinely empty', () => {
  assert.deepEqual(classify([], 12).skipped, []);
});

// The first attempt at visibility only populated `skipped` on the 'nothing'
// branch, so a MIXED diff — one tested source file plus a stylesheet — took the
// fast path and dropped the stylesheet from the report entirely. That is the
// same silent gap, just harder to notice: the run is green AND busy, so nothing
// suggests a file went uncovered. Every classification must carry it.
test('skipped files are reported on the fast path too', () => {
  const root = fixtureRoot(['packages/foo/test'], []);
  try {
    const decision = classify(['packages/foo/lib/x.mjs', 'apps/docs/app/global.css'], 12, root);
    assert.equal(decision.kind, 'fast');
    assert.deepEqual(decision.skipped, ['apps/docs/app/global.css']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('skipped files are reported on the slow path too', () => {
  const root = fixtureRoot([], []);
  try {
    const decision = classify(['some/unmapped/x.mjs', 'README.md'], 12, root);
    assert.equal(decision.kind, 'slow');
    assert.deepEqual(decision.skipped, ['README.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// PYTHON IS DELIBERATELY NOT SOURCE, and this test records why rather than
// leaving it to be "fixed" later by someone reading the mutator's docstring.
//
// The shared mutator calls itself suitable for "JS/TS/Python-style code", and an
// earlier revision of this branch admitted `.py` on that basis. That was wrong
// twice over:
//
//   1. packages/core/lib/mutate.mjs has ZERO Python-aware operators — no
//      `return None`, no `True`/`False`, no `elif`. Its operators are JS-shaped.
//   2. The test exclusion recognizes the dotted JS convention (`*.test.*`,
//      `*.spec.*`) but not Python's, where `test_*.py` / `*_test.py` /
//      `conftest.py` ARE the test files. Admitting `.py` therefore classified
//      pytest modules as production source, so mutating an assertion would make
//      the test fail and be scored "killed" — a vacuously green gate.
//
// Claiming support the operators do not implement is worse than declining it.
// Python support needs Python operators AND Python test discovery; until both
// exist, `.py` is out. See the tracking issue referenced in targets.mjs.
test('Python is not treated as mutable source while operators are JS-shaped', () => {
  for (const f of ['src/app.py', 'src/test_app.py', 'src/app_test.py', 'conftest.py']) {
    assert.equal(hollowTestWouldMutate(f), false, `${f} must not be mutated`);
  }
});

// THE CONTRACT TEST. Both bugs in this file came from the same predicate living
// in two places — packages/hollow-test/lib/targets.mjs and here — and drifting.
// The wrapper deciding a file is not source means hollow-test is never invoked
// for it, so any file the two disagree about is silently unmutated. Assert
// agreement directly rather than trusting two lists to be maintained in step.
test('the wrapper and hollow-test agree on what source is', () => {
  const cases = [
    'a.mjs', 'a.cjs', 'a.js', 'a.jsx', 'a.ts', 'a.mts', 'a.cts', 'a.tsx',
    'packages/x/lib/y.mjs', 'apps/docs/app/page.tsx', 'plugins/p/index.ts',
    'CODEOWNERS', 'LICENSE', 'Dockerfile', 'Makefile', '.gitignore', '.nvmrc',
    'README.md', 'package.json', 'a.yml', 'a.lock', 'a.snap',
    'packages/x/test/y.test.mjs', 'spec/z.mjs',
  ];
  for (const f of cases) {
    assert.equal(
      hollowTestWouldMutate(f),
      isMutableSource(f),
      `wrapper and hollow-test disagree about '${f}' — a disagreement means the ` +
        `gate silently skips it`
    );
  }
});

// End to end at the classify() level: the unit above proves the predicate, this
// proves the predicate is actually what gates the run. A TypeScript-only diff
// must NOT short-circuit to 'nothing'.
// TypeScript is excluded deliberately (#293 — invalid mutants score as kills),
// so the requirement is not that it be mutated but that its exclusion is
// REPORTED. Silence is the failure mode; a declared skip is a coverage boundary.
test('a TypeScript-only diff is reported as skipped, not silently passed', () => {
  const decision = classify(['plugins/adlc-pi/index.ts'], 12);
  assert.equal(decision.kind, 'nothing');
  assert.deepEqual(decision.skipped, ['plugins/adlc-pi/index.ts']);
});

test('hollowTestWouldMutate excludes non-code extensions', () => {
  for (const f of ['a.md', 'a.json', 'a.yml', 'a.yaml', 'a.lock', 'a.txt', 'a.toml', 'a.snap']) {
    assert.equal(hollowTestWouldMutate(`packages/foo/${f}`), false, f);
  }
  for (const f of ['a.mjs', 'a.js', 'a.cjs']) {
    assert.equal(hollowTestWouldMutate(`packages/foo/${f}`), true, f);
  }
});

// -------------------------------------------------------------------- testTargetFor

test('testTargetFor maps a packages/ source to its test directory glob', () => {
  const root = fixtureRoot(['packages/foo/test']);
  try {
    assert.equal(testTargetFor('packages/foo/lib/x.mjs', root), 'packages/foo/test/*.test.mjs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testTargetFor returns null when the package has no test directory', () => {
  const root = fixtureRoot(['packages/foo/lib']);
  try {
    assert.equal(testTargetFor('packages/foo/lib/x.mjs', root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testTargetFor maps apps/<x>/ source to its test directory glob', () => {
  const root = fixtureRoot(['apps/docs/test']);
  try {
    assert.equal(testTargetFor('apps/docs/lib/x.mjs', root), 'apps/docs/test/*.test.mjs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testTargetFor maps plugins/<x>/hooks|lib|agents|mcp to their own test dir when it exists', () => {
  const root = fixtureRoot(['plugins/adlc-codex/hooks/test', 'plugins/adlc-codex/lib/test']);
  try {
    assert.equal(testTargetFor('plugins/adlc-codex/hooks/x.mjs', root), 'plugins/adlc-codex/hooks/test/*.test.mjs');
    assert.equal(testTargetFor('plugins/adlc-codex/lib/x.mjs', root), 'plugins/adlc-codex/lib/test/*.test.mjs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testTargetFor maps plugins/<x>/ source to its test directory glob', () => {
  const root = fixtureRoot(['plugins/adlc-cursor/test']);
  try {
    assert.equal(testTargetFor('plugins/adlc-cursor/rails-checker.mjs', root), 'plugins/adlc-cursor/test/*.test.mjs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testTargetFor maps scripts/<name>.mjs to scripts/test/<name>.test.mjs when it exists', () => {
  const root = fixtureRoot(['scripts/test'], ['scripts/test/mutation-gate.test.mjs']);
  try {
    assert.equal(testTargetFor('scripts/mutation-gate.mjs', root), 'scripts/test/mutation-gate.test.mjs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testTargetFor maps scripts/pi-live-deny.mjs to plugins/adlc-pi/test/*.test.mjs when no same-basename test exists', () => {
  const root = fixtureRoot(['plugins/adlc-pi/test']);
  try {
    assert.equal(testTargetFor('scripts/pi-live-deny.mjs', root), 'plugins/adlc-pi/test/*.test.mjs');
    assert.equal(testTargetFor('scripts/pi-other.mjs', root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testTargetFor does not match a nested scripts/ path as a top-level script', () => {
  const root = fixtureRoot(['scripts/test'], ['scripts/test/mutation-gate.test.mjs']);
  try {
    assert.equal(testTargetFor('scripts/sub/mutation-gate.mjs', root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testTargetFor returns null for a scripts/ file with no matching test', () => {
  const root = fixtureRoot(['scripts/test'], ['scripts/test/unrelated.test.mjs']);
  try {
    assert.equal(testTargetFor('scripts/no-test-for-this.mjs', root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testTargetFor returns null for an unrecognised top-level path or missing test dir', () => {
  const root = fixtureRoot([]);
  try {
    assert.equal(testTargetFor('apps/docs/x.mjs', root), null);
    assert.equal(testTargetFor('README.md', root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------ classify

test('classify: no eligible files reports "nothing"', () => {
  const root = fixtureRoot([]);
  try {
    // `skipped` names what was passed over, so a green gate is never a silent
    // one — see 'classify reports files it skipped rather than silently passing'.
    assert.deepEqual(classify(['README.md', 'packages/foo/test/x.test.mjs'], 12, root), {
      kind: 'nothing',
      skipped: ['README.md', 'packages/foo/test/x.test.mjs'],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('classify: all covered files take the FAST path with no --target-shaped output', () => {
  const root = fixtureRoot(['packages/foo/test', 'packages/bar/test']);
  try {
    const result = classify(['packages/foo/lib/x.mjs', 'packages/bar/lib/y.mjs'], 12, root);
    assert.equal(result.kind, 'fast');
    assert.equal(result.max, 12);
    assert.equal(result.testCmd, 'node --test packages/bar/test/*.test.mjs && node --test packages/foo/test/*.test.mjs');
    assert.deepEqual(result.files.sort(), ['packages/bar/lib/y.mjs', 'packages/foo/lib/x.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('classify: duplicate targets across files collapse to one test invocation', () => {
  const root = fixtureRoot(['packages/foo/test']);
  try {
    const result = classify(['packages/foo/lib/x.mjs', 'packages/foo/lib/y.mjs'], 12, root);
    assert.equal(result.kind, 'fast');
    assert.equal(result.testCmd, 'node --test packages/foo/test/*.test.mjs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('classify: ANY uncovered file forces the SLOW path for the whole batch', () => {
  const root = fixtureRoot(['packages/foo/test']);
  try {
    const result = classify(['packages/foo/lib/x.mjs', 'scripts/uncovered.mjs'], 12, root);
    assert.equal(result.kind, 'slow');
    assert.equal(result.testCmd, 'node scripts/run-tests.mjs');
    assert.deepEqual(result.uncovered, ['scripts/uncovered.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('classify: the slow path caps the mutant budget at 3 regardless of a higher request', () => {
  const root = fixtureRoot([]);
  try {
    const result = classify(['scripts/uncovered.mjs'], 50, root);
    assert.equal(result.kind, 'slow');
    assert.equal(result.max, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('classify: the slow path never raises the budget above what was requested', () => {
  const root = fixtureRoot([]);
  try {
    const result = classify(['scripts/uncovered.mjs'], 1, root);
    assert.equal(result.max, 1, 'min(1, 3) must stay 1, not silently become 3');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('classify: a scripts/ file WITH a matching test takes the fast path, not the fallback', () => {
  // This is the exact scenario that failed in CI before this fix: mutating this
  // very file. With the same-basename mapping and this test file existing,
  // classify() must now choose 'fast', never reaching the unsafe full-suite path.
  const root = fixtureRoot(['scripts/test'], ['scripts/test/mutation-gate.test.mjs']);
  try {
    const result = classify(['scripts/mutation-gate.mjs'], 12, root);
    assert.equal(result.kind, 'fast');
    assert.equal(result.testCmd, 'node --test scripts/test/mutation-gate.test.mjs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('classify: test/spec and non-code files are excluded from consideration entirely', () => {
  const root = fixtureRoot(['packages/foo/test']);
  try {
    const result = classify(
      ['packages/foo/lib/x.mjs', 'packages/foo/test/x.test.mjs', 'package-lock.json'],
      12, root
    );
    assert.equal(result.kind, 'fast');
    assert.deepEqual(result.files, ['packages/foo/lib/x.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --------------------------------------------------------------- self-verification

test('this file itself is what makes mutation-gate.mjs classify as fast-path covered', () => {
  // Runs against the REAL repo root (no fixture) to confirm the self-referential
  // fix actually holds in the real tree, not just in a synthetic fixture.
  const result = classify(['scripts/mutation-gate.mjs'], 12);
  assert.equal(result.kind, 'fast', 'scripts/mutation-gate.mjs must resolve to the fast path in the real repo');
  assert.equal(result.testCmd, 'node --test scripts/test/mutation-gate.test.mjs');
});
