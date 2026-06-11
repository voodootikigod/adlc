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
