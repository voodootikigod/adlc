// Tests for rail-glob resolution and rail-edit detection.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRailSet, railOwners, checkRailEdits, NO_RAILS_ERROR } from '../lib/rails.mjs';

// The single-ticket shapes the old resolver pinned, restated against resolveRailSet
// (#1050 — rails-union.test.mjs holds the multi-ticket union cases).
describe('resolveRailSet — single-ticket shapes', () => {
  test('uses cliRails when provided (even if ticket also has rails), with no owner', () => {
    const ticket = { id: 'T1', title: 't', rails: ['test/**'] };
    const { rails, error } = resolveRailSet({ cliRails: ['src/types/**'], ticket });
    assert.deepEqual(rails, [{ glob: 'src/types/**', owner: null }]);
    assert.equal(error, null);
  });

  test('falls back to ticket.rails when no cliRails and no ticket list is supplied', () => {
    const ticket = { id: 'T1', title: 't', rails: ['test/**', 'schema/**'] };
    const { rails, error } = resolveRailSet({ cliRails: [], ticket });
    assert.deepEqual(rails, [{ glob: 'test/**', owner: 'T1' }, { glob: 'schema/**', owner: 'T1' }]);
    assert.equal(error, null);
  });

  test('errors when no cliRails and no ticket', () => {
    const { rails, error } = resolveRailSet({ cliRails: [], ticket: null });
    assert.equal(rails.length, 0);
    assert.equal(error, NO_RAILS_ERROR);
    assert.ok(error.includes('no --rails'));
  });

  test('errors when no cliRails and the only ticket has no rails', () => {
    const ticket = { id: 'T2', title: 't', rails: [] };
    const { rails, error } = resolveRailSet({ cliRails: [], ticket });
    assert.equal(rails.length, 0);
    assert.equal(error, NO_RAILS_ERROR);
  });

  test('ticket without rails field returns error', () => {
    const ticket = { id: 'T3', title: 't' };
    const { rails, error } = resolveRailSet({ cliRails: [], ticket });
    assert.equal(rails.length, 0);
    assert.ok(error);
  });
});

describe('railOwners', () => {
  test('maps each glob to its first declaring ticket, preferring a real owner over null', () => {
    const owners = railOwners([
      { glob: 'a/**', owner: null },
      { glob: 'a/**', owner: 'T1' },
      { glob: 'b/**', owner: 'T2' },
      { glob: 'b/**', owner: 'T3' },
    ]);
    assert.equal(owners.get('a/**'), 'T1');
    assert.equal(owners.get('b/**'), 'T2');
    assert.equal(owners.has('c/**'), false);
  });
});

describe('checkRailEdits', () => {
  test('flags file matching a rail glob', () => {
    const { violations } = checkRailEdits(['test/auth.test.ts'], ['test/**']);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].type, 'rail-edit');
    assert.equal(violations[0].file, 'test/auth.test.ts');
  });

  test('does not flag file that does not match any rail', () => {
    const { violations } = checkRailEdits(['src/auth.ts'], ['test/**']);
    assert.equal(violations.length, 0);
  });

  test('flags multiple matching files', () => {
    const { violations } = checkRailEdits(
      ['test/a.test.ts', 'src/b.ts', 'test/c.test.ts'],
      ['test/**']
    );
    assert.equal(violations.length, 2);
  });

  test('includes matched globs in violation', () => {
    const { violations } = checkRailEdits(['test/x.ts'], ['test/**', 'test/x.ts']);
    assert.equal(violations[0].globs.length, 2);
  });

  test('returns empty when railGlobs is empty', () => {
    const { violations } = checkRailEdits(['test/foo.ts', 'src/bar.ts'], []);
    assert.equal(violations.length, 0);
  });

  test('handles ** glob across directories', () => {
    const { violations } = checkRailEdits(['a/b/c/d.ts'], ['a/**']);
    assert.equal(violations.length, 1);
  });

  test('returns an empty sanctioned array when no sanctionedAdditions is passed', () => {
    const { sanctioned } = checkRailEdits(['test/auth.test.ts'], ['test/**']);
    assert.deepEqual(sanctioned, []);
  });

  // #1050 — a violation names the ticket that froze the matched glob.
  test('ownerTicket is null when no owners map is supplied', () => {
    const { violations } = checkRailEdits(['test/x.ts'], ['test/**']);
    assert.equal(violations[0].ownerTicket, null);
  });

  test('ownerTicket is the first matched glob\'s owner, skipping cli-owned (null) globs', () => {
    const owners = new Map([['test/**', null], ['test/x.ts', 'T-OTHER']]);
    const { violations } = checkRailEdits(['test/x.ts', 'test/y.ts'], ['test/**', 'test/x.ts'], null, null, owners);
    assert.equal(violations.find((v) => v.file === 'test/x.ts').ownerTicket, 'T-OTHER');
    assert.equal(violations.find((v) => v.file === 'test/y.ts').ownerTicket, null);
  });
});

// #228 — the version-only exemption, exercised through checkRailEdits itself.
// The pure predicate is covered in version-only.test.mjs; these assert the wiring,
// including that the exemption is OFF unless a resolver is supplied.
describe('checkRailEdits — version-only exemption (#228)', () => {
  const PKG = 'packages/build-gate/package.json';
  // Formatted as JSON.stringify(o, null, 2) writes it — that is canonical form,
  // which the exemption requires; a minified fixture would be refused outright.
  const mk = (version, main) =>
    JSON.stringify({ name: '@adlc/build-gate', version, main }, null, 2) + '\n';
  const before = mk('1.5.0', 'lib/i.mjs');
  const bumped = mk('1.5.1', 'lib/i.mjs');
  const edited = mk('1.5.1', 'lib/evil.mjs');

  const resolver = (after) => (file) => (file === PKG ? { before, after } : null);

  test('a version-only bump under a live rail does not violate', () => {
    const { violations } = checkRailEdits([PKG], ['packages/build-gate/**'], resolver(bumped));
    assert.equal(violations.length, 0);
  });

  test('a behaviour edit to the SAME file under the SAME rail still violates', () => {
    const { violations } = checkRailEdits([PKG], ['packages/build-gate/**'], resolver(edited));
    assert.equal(violations.length, 1);
    assert.equal(violations[0].type, 'rail-edit');
  });

  test('a source file under the rail still violates even during a bump', () => {
    const src = 'packages/build-gate/lib/tier.mjs';
    const { violations } = checkRailEdits([src], ['packages/build-gate/**'], resolver(bumped));
    assert.equal(violations.length, 1);
  });

  test('without a resolver the exemption is OFF (backwards compatible, fails closed)', () => {
    const { violations } = checkRailEdits([PKG], ['packages/build-gate/**']);
    assert.equal(violations.length, 1);
  });

  test('a resolver that throws fails closed', () => {
    const boom = () => { throw new Error('git exploded'); };
    const { violations } = checkRailEdits([PKG], ['packages/build-gate/**'], boom);
    assert.equal(violations.length, 1);
  });

  test('a resolver returning null fails closed', () => {
    const { violations } = checkRailEdits([PKG], ['packages/build-gate/**'], () => null);
    assert.equal(violations.length, 1);
  });

  test('a non-manifest file is never sent to the resolver', () => {
    let called = false;
    const spy = () => { called = true; return { before, after: bumped }; };
    const { violations } = checkRailEdits(['packages/build-gate/lib/x.mjs'], ['packages/build-gate/**'], spy);
    assert.equal(called, false);
    assert.equal(violations.length, 1);
  });
});
