import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceTicketOutcomes, statusForTicket } from '../lib/outcomes.mjs';

test('no P5 entry → null status (never fabricate a pass)', () => {
  const entries = [{ ticket: 'T1', gate: 'p0', seq: 1 }, { ticket: 'T1', gate: 'rails-bypass', seq: 2 }];
  assert.equal(statusForTicket(entries, 'T1'), null);
});

test('latest P5 verdict wins (a later pass supersedes an earlier fail)', () => {
  const entries = [
    { ticket: 'T1', gate: 'prosecution', seq: 1, data: { verdict: 'blocked' } },
    { ticket: 'T1', gate: 'prosecution', seq: 5, data: { verdict: 'clear' } },
  ];
  assert.equal(statusForTicket(entries, 'T1'), 'p5-pass');
});

test('latest P5 verdict wins (a later fail supersedes an earlier pass)', () => {
  const entries = [
    { ticket: 'T1', gate: 'prosecution', seq: 5, data: { verdict: 'clear' } },
    { ticket: 'T1', gate: 'prosecution', seq: 9, data: { verdict: 'blocked' } },
  ];
  assert.equal(statusForTicket(entries, 'T1'), 'p5-fail');
});

test('reduces latest-per-gate and is per-ticket', () => {
  const entries = [
    { ticket: 'T1', gate: 'p0', seq: 1 },
    { ticket: 'T1', gate: 'p0', seq: 3 },
    { ticket: 'T2', gate: 'prosecution', seq: 4, data: { verdict: 'clear' } },
  ];
  const r = reduceTicketOutcomes(entries);
  assert.equal(r.get('T1').gates.p0.seq, 3, 'latest p0 entry kept');
  assert.equal(r.get('T2').status, 'p5-pass');
  assert.equal(r.get('T1').status, null);
});

test('entries without a ticket binding are ignored', () => {
  const entries = [{ gate: 'prosecution', seq: 1, data: { verdict: 'clear' } }, { ticket: 'T1', gate: 'p0', seq: 2 }];
  const r = reduceTicketOutcomes(entries);
  assert.equal(r.size, 1);
  assert.ok(r.has('T1'));
});

test('falls back to ts when seq is absent', () => {
  const entries = [
    { ticket: 'T1', gate: 'prosecution', ts: '2026-01-01T00:00:00Z', data: { verdict: 'blocked' } },
    { ticket: 'T1', gate: 'prosecution', ts: '2026-02-01T00:00:00Z', data: { verdict: 'clear' } },
  ];
  assert.equal(statusForTicket(entries, 'T1'), 'p5-pass');
});
