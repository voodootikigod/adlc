import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTicket, validateBlock, validateConfig, validateSyncState,
  CORE_SHARED_FIELDS, errorField,
} from '../lib/validate.mjs';
import { validateTicket as coreValidateTicket } from '@adlc/core';

test('a fully valid ticket has no errors', () => {
  assert.deepEqual(
    validateTicket({ id: 'T1', title: 'Do a thing', scope: ['a/**'], rails: [], edges: [{ to: 'T2' }], duration: 2, category: 'feature', budget: 100 }),
    []
  );
});

test('missing id and title are reported', () => {
  const e = validateTicket({});
  assert.ok(e.some((x) => x.startsWith('id')));
  assert.ok(e.some((x) => x.startsWith('title')));
});

test('EMPTY-string id and title are reported (non-empty constraint is load-bearing)', () => {
  const e = validateTicket({ id: '', title: '' });
  assert.ok(e.some((x) => x.startsWith('id')), 'empty id must be rejected');
  assert.ok(e.some((x) => x.startsWith('title')), 'empty title must be rejected');
});

test('category must be in the enum', () => {
  assert.ok(validateTicket({ id: 'T1', title: 'x', category: 'nope' }).some((x) => x.startsWith('category')));
});

test('duration must be > 0', () => {
  assert.ok(validateTicket({ id: 'T1', title: 'x', duration: 0 }).some((x) => x.startsWith('duration')));
  assert.ok(validateTicket({ id: 'T1', title: 'x', duration: -1 }).some((x) => x.startsWith('duration')));
});

test('non-number / NaN numeric fields are rejected (type guard is load-bearing)', () => {
  assert.ok(validateTicket({ id: 'T1', title: 'x', duration: 'soon' }).some((x) => x === 'duration: expected number'));
  assert.ok(validateTicket({ id: 'T1', title: 'x', budget: Number.NaN }).some((x) => x === 'budget: expected number'));
});

test('edges require a string "to"', () => {
  assert.ok(validateTicket({ id: 'T1', title: 'x', edges: [{}] }).some((x) => x.startsWith('edges')));
  assert.ok(validateTicket({ id: 'T1', title: 'x', edges: [{ to: 5 }] }).some((x) => x.startsWith('edges')));
});

test('wrong types for scope/rails are reported', () => {
  assert.ok(validateTicket({ id: 'T1', title: 'x', scope: 'a/**' }).some((x) => x.startsWith('scope')));
});

test('block accepts the subset and ignores absence of id/title', () => {
  assert.deepEqual(validateBlock({ scope: ['src/**'], rails: ['test/**'], duration: 1, category: 'feature' }), []);
  assert.deepEqual(validateBlock({ $schema: 'https://adlc.dev/schema/v1/adlc-block.schema.json', scope: ['x'] }), []);
});

test('config: ticketSync.provider required + enum-constrained', () => {
  assert.ok(validateConfig({ ticketSync: {} }).some((x) => x.includes('provider')));
  assert.ok(validateConfig({ ticketSync: { provider: 'gitlab' } }).some((x) => x.startsWith('ticketSync.provider')));
  assert.deepEqual(validateConfig({ ticketSync: { provider: 'github', repo: 'a/b' } }), []);
});

test('non-object where an object is expected is rejected (object guard is load-bearing)', () => {
  assert.ok(validateConfig({ ticketSync: 5 }).some((x) => x === 'ticketSync: expected object'));
  // top-level non-object too
  assert.ok(validateTicket('not-a-ticket').some((x) => x.includes('expected object')));
});

test('sync-state: version required + numeric; containers object-typed', () => {
  assert.deepEqual(validateSyncState({ version: 1, tickets: {}, pendingCreates: {} }), []);
  assert.ok(validateSyncState({}).some((x) => x.startsWith('version')));
  assert.ok(validateSyncState({ version: 'one' }).some((x) => x === 'version: expected number'));
  assert.ok(validateSyncState({ version: 1, tickets: [] }).some((x) => x.startsWith('tickets')));
});

test('errorField extracts the leading field name', () => {
  assert.equal(errorField('edges[0].to: required'), 'edges');
  assert.equal(errorField('scope: expected array'), 'scope');
  assert.equal(errorField('$schema: expected string'), '$schema');
});

// ---- cross-validator agreement: the rich validator is a SUPERSET of core's ----

test('CORE_SHARED_FIELDS is exactly the set core.validateTicket inspects', () => {
  // Pinned so the list cannot be silently shrunk (which would hollow the proof below).
  assert.deepEqual([...CORE_SHARED_FIELDS].sort(), ['duration', 'edges', 'id', 'rails', 'scope', 'title']);
});

test('superset proof: for EVERY shared field, a core-rejected ticket is also rich-rejected on that field', () => {
  // Each row is invalid on exactly the named shared field; core rejects it, and the
  // rich validator must report an error on the SAME field. This gives the agreement
  // teeth: removing a field from CORE_SHARED_FIELDS, or having validate stop checking
  // it, breaks this test.
  const cases = {
    id: { id: '', title: 'x' },
    title: { id: 'T1', title: '' },
    scope: { id: 'T1', title: 'x', scope: 'nope' },
    rails: { id: 'T1', title: 'x', rails: 'nope' },
    edges: { id: 'T1', title: 'x', edges: [{}] },
    duration: { id: 'T1', title: 'x', duration: 0 },
  };
  for (const field of CORE_SHARED_FIELDS) {
    const t = cases[field];
    assert.ok(t, `no case for shared field ${field}`);
    assert.ok(coreValidateTicket(t).length > 0, `core should reject the ${field} case`);
    assert.ok(
      validateTicket(t).some((e) => errorField(e) === field),
      `rich validator must also reject on shared field ${field}`
    );
  }
});

test('agreement direction: every core-accepted ticket is rich-valid on shared fields', () => {
  const corpus = [
    { id: 'T1', title: 'a' },
    { id: 'T2', title: 'b', scope: ['x'], rails: ['y'], edges: [{ to: 'T1' }], duration: 3 },
    { id: 'T3', title: 'c', category: 'something-core-ignores' }, // non-shared rich-only constraint
    { id: 'T4', title: 'd', edges: [{ to: 'T1' }, { to: 'T2' }], duration: 1 },
  ];
  for (const t of corpus) {
    if (coreValidateTicket(t).length) continue;
    const sharedErrors = validateTicket(t).filter((e) => CORE_SHARED_FIELDS.includes(errorField(e)));
    assert.deepEqual(sharedErrors, [], `shared-field disagreement for ${t.id}: ${sharedErrors.join('; ')}`);
  }
});
