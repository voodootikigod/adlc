import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLead, LEAD_LIMITS } from '../lib/contact/schema.mjs';

// AC1: the Lead schema rejects malformed input and accepts a valid lead.

test('rejects an empty name', () => {
  const r = parseLead({ name: '   ', email: 'a@b.com', message: 'hello there' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.name, 'expected a name error');
});

test('rejects an invalid email', () => {
  const r = parseLead({ name: 'Ada', email: 'not-an-email', message: 'hello there' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.email, 'expected an email error');
});

test('rejects an over-long message', () => {
  const long = 'x'.repeat(LEAD_LIMITS.message + 1);
  const r = parseLead({ name: 'Ada', email: 'a@b.com', message: long });
  assert.equal(r.ok, false);
  assert.ok(r.errors.message, 'expected a message error');
});

test('rejects a missing message', () => {
  const r = parseLead({ name: 'Ada', email: 'a@b.com' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.message);
});

test('accepts a well-formed lead and trims/normalizes it', () => {
  const r = parseLead({
    name: '  Ada Lovelace  ',
    email: '  ADA@Example.com ',
    company: '  Analytical Engines  ',
    message: '  We are rolling out agents.  ',
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.name, 'Ada Lovelace');
  assert.equal(r.value.email, 'ada@example.com');
  assert.equal(r.value.company, 'Analytical Engines');
  assert.equal(r.value.message, 'We are rolling out agents.');
});

test('company is optional and defaults to empty string', () => {
  const r = parseLead({ name: 'Ada', email: 'a@b.com', message: 'hello there' });
  assert.equal(r.ok, true);
  assert.equal(r.value.company, '');
});
