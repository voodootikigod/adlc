// Tests for rail-glob resolution and rail-edit detection.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRailGlobs, checkRailEdits } from '../lib/rails.mjs';

describe('resolveRailGlobs', () => {
  test('uses cliRails when provided (even if ticket also has rails)', () => {
    const ticket = { id: 'T1', title: 't', rails: ['test/**'] };
    const { globs, error } = resolveRailGlobs(['src/types/**'], ticket);
    assert.deepEqual(globs, ['src/types/**']);
    assert.equal(error, null);
  });

  test('falls back to ticket.rails when no cliRails', () => {
    const ticket = { id: 'T1', title: 't', rails: ['test/**', 'schema/**'] };
    const { globs, error } = resolveRailGlobs([], ticket);
    assert.deepEqual(globs, ['test/**', 'schema/**']);
    assert.equal(error, null);
  });

  test('errors when no cliRails and no ticket', () => {
    const { globs, error } = resolveRailGlobs([], null);
    assert.equal(globs.length, 0);
    assert.ok(error);
    assert.ok(error.includes('no --rails'));
  });

  test('errors when no cliRails and ticket has no rails', () => {
    const ticket = { id: 'T2', title: 't', rails: [] };
    const { globs, error } = resolveRailGlobs([], ticket);
    assert.equal(globs.length, 0);
    assert.ok(error);
    assert.ok(error.includes('no rails declared'));
  });

  test('ticket without rails field returns error', () => {
    const ticket = { id: 'T3', title: 't' };
    const { globs, error } = resolveRailGlobs([], ticket);
    assert.equal(globs.length, 0);
    assert.ok(error);
  });
});

describe('checkRailEdits', () => {
  test('flags file matching a rail glob', () => {
    const violations = checkRailEdits(['test/auth.test.ts'], ['test/**']);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].type, 'rail-edit');
    assert.equal(violations[0].file, 'test/auth.test.ts');
  });

  test('does not flag file that does not match any rail', () => {
    const violations = checkRailEdits(['src/auth.ts'], ['test/**']);
    assert.equal(violations.length, 0);
  });

  test('flags multiple matching files', () => {
    const violations = checkRailEdits(
      ['test/a.test.ts', 'src/b.ts', 'test/c.test.ts'],
      ['test/**']
    );
    assert.equal(violations.length, 2);
  });

  test('includes matched globs in violation', () => {
    const violations = checkRailEdits(['test/x.ts'], ['test/**', 'test/x.ts']);
    assert.equal(violations[0].globs.length, 2);
  });

  test('returns empty when railGlobs is empty', () => {
    const violations = checkRailEdits(['test/foo.ts', 'src/bar.ts'], []);
    assert.equal(violations.length, 0);
  });

  test('handles ** glob across directories', () => {
    const violations = checkRailEdits(['a/b/c/d.ts'], ['a/**']);
    assert.equal(violations.length, 1);
  });
});

// #228 — the version-only exemption, exercised through checkRailEdits itself.
// The pure predicate is covered in version-only.test.mjs; these assert the wiring,
// including that the exemption is OFF unless a resolver is supplied.
describe('checkRailEdits — version-only exemption (#228)', () => {
  const PKG = 'packages/build-gate/package.json';
  // Formatted as JSON.stringify(o, null, 2) writes it — the exemption is a
  // line-level text check, so a minified fixture would not exercise it.
  const mk = (version, main) =>
    JSON.stringify({ name: '@adlc/build-gate', version, main }, null, 2) + '\n';
  const before = mk('1.5.0', 'lib/i.mjs');
  const bumped = mk('1.5.1', 'lib/i.mjs');
  const edited = mk('1.5.1', 'lib/evil.mjs');

  const resolver = (after) => (file) => (file === PKG ? { before, after } : null);

  test('a version-only bump under a live rail does not violate', () => {
    const violations = checkRailEdits([PKG], ['packages/build-gate/**'], resolver(bumped));
    assert.equal(violations.length, 0);
  });

  test('a behaviour edit to the SAME file under the SAME rail still violates', () => {
    const violations = checkRailEdits([PKG], ['packages/build-gate/**'], resolver(edited));
    assert.equal(violations.length, 1);
    assert.equal(violations[0].type, 'rail-edit');
  });

  test('a source file under the rail still violates even during a bump', () => {
    const src = 'packages/build-gate/lib/tier.mjs';
    const violations = checkRailEdits([src], ['packages/build-gate/**'], resolver(bumped));
    assert.equal(violations.length, 1);
  });

  test('without a resolver the exemption is OFF (backwards compatible, fails closed)', () => {
    const violations = checkRailEdits([PKG], ['packages/build-gate/**']);
    assert.equal(violations.length, 1);
  });

  test('a resolver that throws fails closed', () => {
    const boom = () => { throw new Error('git exploded'); };
    const violations = checkRailEdits([PKG], ['packages/build-gate/**'], boom);
    assert.equal(violations.length, 1);
  });

  test('a resolver returning null fails closed', () => {
    const violations = checkRailEdits([PKG], ['packages/build-gate/**'], () => null);
    assert.equal(violations.length, 1);
  });

  test('a non-manifest file is never sent to the resolver', () => {
    let called = false;
    const spy = () => { called = true; return { before, after: bumped }; };
    const violations = checkRailEdits(['packages/build-gate/lib/x.mjs'], ['packages/build-gate/**'], spy);
    assert.equal(called, false);
    assert.equal(violations.length, 1);
  });
});
