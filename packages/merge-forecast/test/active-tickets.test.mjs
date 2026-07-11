// Tests for the completed-ticket (tombstone) filter and its DAG-safety.
// A ticket carrying `completed: true` must not be scheduled as open backlog,
// and dropping it must not break the topo schedule of tickets that depended
// on it (a completed prerequisite is satisfied).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeTickets } from '../lib/active-tickets.mjs';
import { topoWaves } from '../lib/reachability.mjs';

test('activeTickets: passes the array through unchanged (same reference) when nothing is completed', () => {
  const tickets = [{ id: 'T1' }, { id: 'T2', edges: [{ to: 'T1' }] }];
  assert.equal(activeTickets(tickets), tickets);
});

test('activeTickets: drops a completed:true ticket', () => {
  const out = activeTickets([{ id: 'T1' }, { id: 'T2', completed: true }]);
  assert.deepEqual(out.map((t) => t.id), ['T1']);
});

test('activeTickets: only STRICT true counts — completed:"true"/1/false stay active', () => {
  const out = activeTickets([
    { id: 'T1', completed: 'true' },
    { id: 'T2', completed: 1 },
    { id: 'T3', completed: false },
  ]);
  assert.deepEqual(out.map((t) => t.id), ['T1', 'T2', 'T3']);
});

test('activeTickets: strips an edge pointing to a completed prerequisite from a survivor, and does so immutably (original untouched)', () => {
  const original = [
    { id: 'T1', completed: true },
    { id: 'T2', edges: [{ to: 'T1' }, { to: 'T3' }] },
    { id: 'T3' },
  ];
  const out = activeTickets(original);
  const t2 = out.find((t) => t.id === 'T2');
  assert.deepEqual(t2.edges, [{ to: 'T3' }]); // edge to completed T1 removed
  // immutability: the input ticket object was not mutated.
  assert.deepEqual(original[1].edges, [{ to: 'T1' }, { to: 'T3' }]);
  assert.notEqual(t2, original[1]);
});

test('activeTickets: a survivor with no edge to a completed ticket keeps its object identity (no needless copy)', () => {
  const t3 = { id: 'T3', edges: [{ to: 'T4' }] };
  const out = activeTickets([{ id: 'T1', completed: true }, t3, { id: 'T4' }]);
  assert.equal(out.find((t) => t.id === 'T3'), t3);
});

test('DAG-safety: topoWaves over the filtered set excludes the completed ticket AND leaves a ticket that only depended on it unblocked in the first wave', () => {
  // T1 (completed) → T2 means "T1 must complete before T2". T1 is done, so T2
  // should be immediately schedulable, not stuck waiting on a ghost prereq.
  const tickets = [
    { id: 'T1', completed: true, edges: [{ to: 'T2' }] },
    { id: 'T2', title: 'depends only on completed T1' },
    { id: 'T3', title: 'independent' },
  ];
  const waves = topoWaves(activeTickets(tickets));
  const allScheduled = waves.flat();
  assert.ok(!allScheduled.includes('T1'), 'completed T1 must not be scheduled');
  // T2 and T3 both land in the first wave — T2 is no longer gated by T1.
  assert.deepEqual([...waves[0]].sort(), ['T2', 'T3']);
});
