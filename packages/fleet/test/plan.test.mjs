import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeTickets,
  predecessorsOf,
  computeReady,
  unsatisfiableInSubset,
  selectDispatchable,
} from '../lib/plan.mjs';

// Minimal ticket fixtures. Edge direction is prerequisite → dependent:
// an edge {to: X} on T means "T must merge before X".
const T = (id, opts = {}) => ({
  id,
  title: id,
  scope: opts.scope ?? [`src/${id}/**`],
  edges: opts.edges ?? [],
  ...(opts.completed ? { completed: true } : {}),
});

test('activeTickets filters completed:true (invariant #104)', () => {
  const all = [T('T1'), T('T2', { completed: true }), T('T3')];
  assert.deepEqual(activeTickets(all).map((t) => t.id), ['T1', 'T3']);
});

test('predecessorsOf resolves edge direction prerequisite→dependent', () => {
  const all = [T('T1', { edges: [{ to: 'T3' }] }), T('T2', { edges: [{ to: 'T3' }] }), T('T3')];
  assert.deepEqual(predecessorsOf('T3', all).sort(), ['T1', 'T2']);
  assert.deepEqual(predecessorsOf('T1', all), []);
});

test('a ticket dispatches only after ALL edge predecessors merge (AC3a)', () => {
  const all = [T('T1', { edges: [{ to: 'T3' }] }), T('T2', { edges: [{ to: 'T3' }] }), T('T3')];
  // Nothing merged yet: only T1, T2 are ready; T3 waits on both.
  let ready = computeReady(all, { statusById: {} }).map((t) => t.id);
  assert.deepEqual(ready.sort(), ['T1', 'T2']);
  // Only T1 merged: T3 still waits on T2.
  ready = computeReady(all, { statusById: { T1: 'merged' } }).map((t) => t.id);
  assert.ok(!ready.includes('T3'), 'T3 must not be ready with one predecessor unmerged');
  // Both merged: T3 becomes ready.
  ready = computeReady(all, { statusById: { T1: 'merged', T2: 'merged' } }).map((t) => t.id);
  assert.deepEqual(ready, ['T3']);
});

test('completed:true predecessor satisfies an edge without being dispatched (AC3b)', () => {
  const all = [T('T1', { completed: true, edges: [{ to: 'T2' }] }), T('T2')];
  const ready = computeReady(all, { statusById: {} }).map((t) => t.id);
  // T1 is completed → never dispatched, but its edge to T2 is satisfied.
  assert.deepEqual(ready, ['T2']);
});

test('scope-overlapping tickets are never concurrent (AC3d)', () => {
  const all = [T('T1', { scope: ['src/shared/**'] }), T('T2', { scope: ['src/shared/util.js'] })];
  // T1 in flight → T2 (overlapping scope) is held out of the ready set.
  const ready = computeReady(all, { statusById: { T1: 'building' }, inFlightIds: ['T1'] }).map((t) => t.id);
  assert.deepEqual(ready, [], 'overlapping ticket must not be ready while the other is in flight');
});

test('non-overlapping tickets run concurrently', () => {
  const all = [T('T1', { scope: ['src/a/**'] }), T('T2', { scope: ['src/b/**'] })];
  const ready = computeReady(all, { statusById: { T1: 'building' }, inFlightIds: ['T1'] }).map((t) => t.id);
  assert.deepEqual(ready, ['T2']);
});

test('an in-flight ticket is not re-dispatched', () => {
  const all = [T('T1')];
  const ready = computeReady(all, { statusById: { T1: 'building' }, inFlightIds: ['T1'] });
  assert.deepEqual(ready, []);
});

test('selectDispatchable respects free slots and mutual scope exclusion', () => {
  const a = { id: 'A', scope: ['src/a/**'] };
  const b = { id: 'B', scope: ['src/a/inner.js'] }; // overlaps A
  const c = { id: 'C', scope: ['src/c/**'] };
  // 3 free slots, but A and B overlap → only A and C admitted.
  const picked = selectDispatchable([a, b, c], [], 3).map((t) => t.id);
  assert.deepEqual(picked, ['A', 'C']);
  // Free-slot cap of 1 → only the first.
  assert.deepEqual(selectDispatchable([a, b, c], [], 1).map((t) => t.id), ['A']);
});

test('selectDispatchable excludes tickets overlapping the in-flight set', () => {
  const inflight = [{ id: 'X', scope: ['src/a/**'] }];
  const b = { id: 'B', scope: ['src/a/deep.js'] };
  const c = { id: 'C', scope: ['src/c/**'] };
  const picked = selectDispatchable([b, c], inflight, 5).map((t) => t.id);
  assert.deepEqual(picked, ['C']);
});

test('unsatisfiableInSubset flags a subset member whose predecessor is excluded', () => {
  const all = [T('T1', { edges: [{ to: 'T2' }] }), T('T2')];
  // Run only T2, but its predecessor T1 is neither in the subset nor merged.
  assert.deepEqual(unsatisfiableInSubset(all, { onlyIds: ['T2'], statusById: {} }), ['T2']);
  // If T1 is already merged, T2 is satisfiable.
  assert.deepEqual(unsatisfiableInSubset(all, { onlyIds: ['T2'], statusById: { T1: 'merged' } }), []);
});
