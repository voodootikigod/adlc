import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeTickets, isPlainObject, OpError } from '../index.mjs';

test('activeTickets: passes the array through unchanged when nothing is completed', () => {
  const tickets = [{ id: 'T1' }, { id: 'T2', edges: [{ to: 'T1' }] }];
  assert.equal(activeTickets(tickets), tickets);
});

test('activeTickets: filters completed tickets (completed: true)', () => {
  const out = activeTickets([{ id: 'T1' }, { id: 'T2', completed: true }]);
  assert.deepEqual(out.map((t) => t.id), ['T1']);
});

test('activeTickets: only strict boolean true counts as completed', () => {
  const out = activeTickets([
    { id: 'T1', completed: 'true' },
    { id: 'T2', completed: 1 },
    { id: 'T3', completed: false },
    { id: 'T4', completed: null },
    { id: 'T5', completed: undefined },
  ]);
  assert.deepEqual(out.map((t) => t.id), ['T1', 'T2', 'T3', 'T4', 'T5']);
});

test('activeTickets: drops edges pointing to completed tickets', () => {
  const original = [
    { id: 'T1', completed: true },
    { id: 'T2', edges: [{ to: 'T1' }, { to: 'T3' }] },
    { id: 'T3' },
  ];
  const out = activeTickets(original);
  assert.equal(out.length, 2);
  const t2 = out.find((t) => t.id === 'T2');
  assert.deepEqual(t2.edges, [{ to: 'T3' }]);
  // Immutability: original ticket edges untouched
  assert.deepEqual(original[1].edges, [{ to: 'T1' }, { to: 'T3' }]);
});

test('activeTickets: survivor with no edges to completed tickets preserves reference', () => {
  const t3 = { id: 'T3', edges: [{ to: 'T4' }] };
  const out = activeTickets([{ id: 'T1', completed: true }, t3, { id: 'T4' }]);
  assert.equal(out.find((t) => t.id === 'T3'), t3);
});

test('isPlainObject: true for {}, {a: 1}, Object.create(null)', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject(Object.create(null)), true);
});

test("isPlainObject: false for [], null, undefined, 1, 'str', new Set()", () => {
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(undefined), false);
  assert.equal(isPlainObject(1), false);
  assert.equal(isPlainObject('str'), false);
  assert.equal(isPlainObject(new Set()), false);
  assert.equal(isPlainObject(new Map()), false);
  assert.equal(isPlainObject(new Date()), false);
  assert.equal(isPlainObject(() => {}), false);
  assert.equal(isPlainObject(true), false);
});

test('OpError: instanceof Error, isOpError: true, name: OpError', () => {
  const err = new OpError('something failed');
  assert.ok(err instanceof Error);
  assert.equal(err.isOpError, true);
  assert.equal(err.name, 'OpError');
  assert.equal(err.message, 'something failed');
});
