import { test } from 'node:test';
import assert from 'node:assert/strict';
import { railScopeGuard, describeViolations } from '../lib/rails-guard-sync.mjs';

test('pure rail addition is allowed (incoming superset of local)', () => {
  const r = railScopeGuard({ localRails: ['t/**'], incomingRails: ['t/**', 'x/**'] });
  assert.ok(r.ok);
  assert.deepEqual(r.violations, []);
});

test('rail removal is flagged', () => {
  const r = railScopeGuard({ localRails: ['t/**', 'x/**'], incomingRails: ['t/**'] });
  assert.ok(!r.ok);
  assert.ok(r.violations.some((v) => v.kind === 'rail-removed' && v.value === 'x/**'));
});

test('rail replacement (even a broader glob) is flagged — string-set, no glob reasoning', () => {
  const r = railScopeGuard({ localRails: ['test/auth/**'], incomingRails: ['test/**'] });
  assert.ok(!r.ok);
  assert.ok(r.violations.some((v) => v.kind === 'rail-removed' && v.value === 'test/auth/**'));
});

test('scope narrowing (subset) is allowed', () => {
  const r = railScopeGuard({ localScope: ['src/**'], incomingScope: ['src/auth/**'] });
  // src/auth/** is NOT in local set {src/**} as a STRING, so by the conservative
  // string-set rule it IS flagged as a widening. Verify the fail-safe direction:
  assert.ok(!r.ok);
});

test('identical scope is allowed', () => {
  assert.ok(railScopeGuard({ localScope: ['src/**'], incomingScope: ['src/**'] }).ok);
});

test('scope widening (adding a glob) is flagged', () => {
  const r = railScopeGuard({ localScope: ['src/**'], incomingScope: ['src/**', '**'] });
  assert.ok(!r.ok);
  assert.ok(r.violations.some((v) => v.kind === 'scope-widened' && v.value === '**'));
});

test('describeViolations renders a readable summary', () => {
  const r = railScopeGuard({ localRails: ['a'], incomingRails: [], localScope: ['s'], incomingScope: ['s', 'w'] });
  const text = describeViolations(r.violations);
  assert.match(text, /rail removed/);
  assert.match(text, /scope widened/);
});

test('empty/undefined inputs are safe (no violations)', () => {
  assert.ok(railScopeGuard({}).ok);
});
