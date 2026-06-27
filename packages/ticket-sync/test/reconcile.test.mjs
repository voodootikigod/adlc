import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileBlock } from '../lib/reconcile.mjs';
import { canonicalHash } from '../lib/canonical.mjs';

const A = { scope: ['a/**'], rails: ['t/**'], duration: 1 };
const B = { scope: ['b/**'], rails: ['t/**'], duration: 2 };
const hash = (x) => canonicalHash(x, { omit: ['$schema'] });

test('converged: local and remote identical → converged (no base needed)', () => {
  assert.equal(reconcileBlock({ baseHash: null, local: A, remote: { ...A } }).action, 'converged');
});

test('converged: both-absent → converged', () => {
  assert.equal(reconcileBlock({ baseHash: null, local: null, remote: null }).action, 'converged');
});

test('take-remote: remote changed, local still at base', () => {
  assert.equal(reconcileBlock({ baseHash: hash(A), local: A, remote: B }).action, 'take-remote');
});

test('keep-local: local changed, remote still at base', () => {
  assert.equal(reconcileBlock({ baseHash: hash(A), local: B, remote: A }).action, 'keep-local');
});

test('conflict: both changed since base, to different values', () => {
  const C = { scope: ['c/**'], duration: 9 };
  const r = reconcileBlock({ baseHash: hash(A), local: B, remote: C });
  assert.equal(r.action, 'conflict');
});

test('fail safe: no base AND local != remote → conflict (never silent take-remote)', () => {
  const r = reconcileBlock({ baseHash: null, local: A, remote: B });
  assert.equal(r.action, 'conflict');
  assert.match(r.reason, /no base/);
});

test('$schema is ignored when deciding (hash omits it)', () => {
  const withSchema = { ...A, $schema: 'https://adlc.dev/schema/v1/adlc-block.schema.json' };
  assert.equal(reconcileBlock({ baseHash: hash(A), local: A, remote: withSchema }).action, 'converged');
});

test('both edited to the SAME value → converged, not conflict', () => {
  assert.equal(reconcileBlock({ baseHash: hash(A), local: B, remote: { ...B } }).action, 'converged');
});
