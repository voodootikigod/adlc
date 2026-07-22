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

test('testTargetFor maps plugins/<x>/hooks|lib|agents|mcp to their own test dir', () => {
  const root = fixtureRoot(['plugins/adlc-codex/hooks/test', 'plugins/adlc-codex/lib/test']);
  try {
    assert.equal(testTargetFor('plugins/adlc-codex/hooks/x.mjs', root), 'plugins/adlc-codex/hooks/test/*.test.mjs');
    assert.equal(testTargetFor('plugins/adlc-codex/lib/x.mjs', root), 'plugins/adlc-codex/lib/test/*.test.mjs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testTargetFor falls back to plugins/<x>/test for other plugin subpaths', () => {
  const root = fixtureRoot(['plugins/adlc-cursor/test']);
  try {
    assert.equal(testTargetFor('plugins/adlc-cursor/rails-checker.mjs', root), 'plugins/adlc-cursor/test/*.test.mjs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testTargetFor maps scripts/<name>.mjs to scripts/test/<name>.test.mjs when it exists', () => {
  // The exact fix for #260's own failure: this repo's same-basename convention,
  // applied to scripts/ so a covered scripts/ file takes the fast, single-file
  // path instead of the slow full-suite fallback.
  const root = fixtureRoot(['scripts/test'], ['scripts/test/mutation-gate.test.mjs']);
  try {
    assert.equal(testTargetFor('scripts/mutation-gate.mjs', root), 'scripts/test/mutation-gate.test.mjs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testTargetFor returns null for a scripts/ file with no matching test', () => {
  const root = fixtureRoot(['scripts/test'], ['scripts/test/unrelated.test.mjs']);
  try {
    assert.equal(testTargetFor('scripts/no-test-for-this.mjs', root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testTargetFor does not match a nested scripts/ path as a top-level script', () => {
  // scripts/foo/bar.mjs is not scripts/<name>.mjs — the regex is anchored to
  // exactly one path segment between scripts/ and .mjs.
  const root = fixtureRoot(['scripts/test'], ['scripts/test/bar.test.mjs']);
  try {
    assert.equal(testTargetFor('scripts/foo/bar.mjs', root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('testTargetFor returns null for an unrecognised top-level path', () => {
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
    assert.deepEqual(classify(['README.md', 'packages/foo/test/x.test.mjs'], 12, root), { kind: 'nothing' });
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
