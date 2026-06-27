import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTicket, validateBlock, validateConfig, CORE_SHARED_FIELDS, errorField } from '../lib/validate.mjs';
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

test('category must be in the enum', () => {
  const e = validateTicket({ id: 'T1', title: 'x', category: 'nope' });
  assert.ok(e.some((x) => x.startsWith('category')));
});

test('duration must be > 0', () => {
  assert.ok(validateTicket({ id: 'T1', title: 'x', duration: 0 }).some((x) => x.startsWith('duration')));
  assert.ok(validateTicket({ id: 'T1', title: 'x', duration: -1 }).some((x) => x.startsWith('duration')));
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

test('config requires ticketSync.provider', () => {
  assert.ok(validateConfig({ ticketSync: {} }).some((x) => x.includes('provider')));
  assert.deepEqual(validateConfig({ ticketSync: { provider: 'github', repo: 'a/b' } }), []);
});

test('errorField extracts the leading field name', () => {
  assert.equal(errorField('edges[0].to: required'), 'edges');
  assert.equal(errorField('scope: expected array'), 'scope');
  assert.equal(errorField('$schema: expected string'), '$schema');
});

test('cross-validator agreement: every core-valid ticket is rich-valid on shared fields', () => {
  const corpus = [
    { id: 'T1', title: 'a' },
    { id: 'T2', title: 'b', scope: ['x'], rails: ['y'], edges: [{ to: 'T1' }], duration: 3 },
    // core ignores `category`, so a value our enum rejects must NOT count as a
    // shared-field disagreement (it's a non-shared, rich-only constraint):
    { id: 'T3', title: 'c', category: 'something-core-ignores' },
    { id: 'T4', title: 'd', edges: [{ to: 'T1' }, { to: 'T2' }], duration: 1 },
  ];
  for (const t of corpus) {
    if (coreValidateTicket(t).length) continue; // only assert on tickets core accepts
    const sharedErrors = validateTicket(t).filter((e) => CORE_SHARED_FIELDS.includes(errorField(e)));
    assert.deepEqual(sharedErrors, [], `shared-field disagreement for ${t.id}: ${sharedErrors.join('; ')}`);
  }
});
