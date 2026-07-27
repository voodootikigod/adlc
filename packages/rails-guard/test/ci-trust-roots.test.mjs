// The immutable trust-root set (#140).
//
// This list decides what the gate refuses to let a PR touch. Every assertion here guards
// a direction that would WEAKEN it: silently dropping a default, letting a caller shrink
// the set, or freezing paths in a repo that has nothing frozen yet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IMMUTABLE_TRUST_ROOTS, resolveImmutableTrustRoots } from '../lib/ci/trust-roots.mjs';

// #363 cross-model review, blocking finding 1: these were briefly passed in via
// --trust-root from scripts/rails-guard-ci.mjs. That let ONE PR drop the arguments AND
// remove the wrapper from the defaults, unprotecting both enforcement sources at once.
// They must stay in the defaults, where disarming the gate requires editing a covered file.
test('the gate\'s own sources are frozen by DEFAULT, not by a caller-supplied list', () => {
  for (const path of [
    'packages/rails-guard/lib/ci/**',
    'packages/rails-guard/bin/rails-guard-ci.mjs',
    'packages/rails-guard/bin/rails-guard.mjs',
    'packages/rails-guard/lib/trust-root-authorization.mjs',
    'scripts/rails-guard-ci.mjs',
    'docs/ci/rails-guard.yml',
  ]) {
    assert.ok(DEFAULT_IMMUTABLE_TRUST_ROOTS.includes(path), `${path} must be frozen without any caller argument`);
  }
  // And with NO additional roots at all, they are still frozen.
  const roots = resolveImmutableTrustRoots({ additional: [] });
  assert.ok(roots.includes('packages/rails-guard/lib/ci/**'));
  assert.ok(roots.includes('scripts/rails-guard-ci.mjs'));
});

test('the default set covers the paths that decide enforcement in any repo', () => {
  for (const path of [
    '.adlc/config.json',
    '.adlc/admin.pub',
    '.adlc/tickets/.store.json',
    '.github/workflows/adlc-rails-guard.yml',
    'CODEOWNERS',
    '.github/CODEOWNERS',
    'docs/CODEOWNERS',
  ]) {
    assert.ok(DEFAULT_IMMUTABLE_TRUST_ROOTS.includes(path), `${path} must be frozen by default`);
  }
});

test('the default set is frozen so a caller cannot mutate the shared list', () => {
  assert.throws(() => DEFAULT_IMMUTABLE_TRUST_ROOTS.push('anything'), TypeError);
});

test('additional trust roots are ADDED to the defaults, never substituted for them', () => {
  const roots = resolveImmutableTrustRoots({ additional: ['packages/rails-guard/lib/ci/**'] });
  assert.ok(roots.includes('packages/rails-guard/lib/ci/**'));
  for (const path of DEFAULT_IMMUTABLE_TRUST_ROOTS) {
    assert.ok(roots.includes(path), `${path} must survive when extras are supplied`);
  }
});

test('an empty or junk additional list cannot shrink the defaults', () => {
  for (const additional of [[], ['', '   '], [null, undefined, 42]]) {
    const roots = resolveImmutableTrustRoots({ additional });
    for (const path of DEFAULT_IMMUTABLE_TRUST_ROOTS) {
      assert.ok(roots.includes(path), `${path} must survive additional=${JSON.stringify(additional)}`);
    }
  }
});

test('duplicates collapse without dropping a distinct root', () => {
  const roots = resolveImmutableTrustRoots({ additional: ['CODEOWNERS', 'CODEOWNERS', 'extra.mjs'] });
  assert.equal(roots.filter((r) => r === 'CODEOWNERS').length, 1);
  assert.ok(roots.includes('extra.mjs'));
});

// A verified migration CREATES .adlc/tickets/.store.json. Freezing it would deny the very
// ceremony the gate just proved valid — but ONLY that one path may be lifted.
test('a verified migration lifts the store manifest and nothing else', () => {
  const roots = resolveImmutableTrustRoots({ verifiedMigration: true });
  assert.ok(!roots.includes('.adlc/tickets/.store.json'), 'the migrated store manifest must not be frozen');
  for (const path of DEFAULT_IMMUTABLE_TRUST_ROOTS) {
    if (path === '.adlc/tickets/.store.json') continue;
    assert.ok(roots.includes(path), `${path} must stay frozen through a migration`);
  }
});

test('without a verified migration the store manifest stays frozen', () => {
  assert.ok(resolveImmutableTrustRoots({}).includes('.adlc/tickets/.store.json'));
});

// Before a repo has declared rails or a base config there is nothing frozen. Reporting
// trust roots then would deny ordinary changes in a repo that never opted in.
test('an unbootstrapped repo has no trust roots at all', () => {
  assert.deepEqual(resolveImmutableTrustRoots({ bootstrapped: false, additional: ['x.mjs'] }), []);
});

test('resolving with no arguments still yields the full default set', () => {
  assert.deepEqual(resolveImmutableTrustRoots(), [...DEFAULT_IMMUTABLE_TRUST_ROOTS]);
});
