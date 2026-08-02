import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeDenyRecord } from '../lib/deny-lifecycle.mjs';
import { evaluateMutationGate } from '../lib/mutation-gate.mjs';

test('same-session consume rejected', () => {
  const r = consumeDenyRecord(
    { session_id: 's1', ticket_id: 'T154', content_hash: 'h', status: 'open' },
    's1',
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /same-session/);
  assert.equal(r.exitCode, 2);
});

test('consume transitions open → consumed; denier stays D2; consumer authorized', () => {
  const denier = { session_id: 's1', ticket_id: 'T154', content_hash: 'h', status: 'open' };
  const consumed = consumeDenyRecord(denier, 's2');
  assert.equal(consumed.ok, true);
  assert.equal(consumed.record.status, 'consumed');

  const denierGate = evaluateMutationGate({
    currentSessionId: 's1',
    denyRecords: [consumed.record],
    resumeAuth: { ticket_id: 'T154', content_hash: 'h', verified: true },
  });
  assert.equal(denierGate.deny, true, 'denier sticky after consume');

  const otherGate = evaluateMutationGate({
    currentSessionId: 's2',
    denyRecords: [consumed.record],
    resumeAuth: { ticket_id: 'T154', content_hash: 'h', verified: true },
  });
  assert.equal(otherGate.deny, false, 'consumed drops D3 when authorized');
});

test('cannot consume without hash/ticket', () => {
  assert.equal(
    consumeDenyRecord({ session_id: 's1', ticket_id: null, content_hash: 'h', status: 'open' }, 's2').ok,
    false,
  );
});

test('null content_hash cannot consume', () => {
  const r = consumeDenyRecord(
    { session_id: 's1', ticket_id: 'T154', content_hash: null, status: 'open' },
    's2',
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot consume/);
});

test('empty-string ticket_id/content_hash cannot consume', () => {
  assert.equal(
    consumeDenyRecord(
      { session_id: 's1', ticket_id: '', content_hash: 'h', status: 'open' },
      's2',
    ).ok,
    false,
  );
  assert.equal(
    consumeDenyRecord(
      { session_id: 's1', ticket_id: 'T154', content_hash: '  ', status: 'open' },
      's2',
    ).ok,
    false,
  );
});

test('null/missing record cannot consume', () => {
  assert.equal(consumeDenyRecord(null, 's2').ok, false);
  assert.equal(consumeDenyRecord(undefined, 's2').ok, false);
  assert.match(consumeDenyRecord(null, 's2').error, /missing deny record/);
});

test('missing/empty consumer session id cannot consume', () => {
  const open = { session_id: 's1', ticket_id: 'T154', content_hash: 'h', status: 'open' };
  assert.equal(consumeDenyRecord(open, '').ok, false);
  assert.equal(consumeDenyRecord(open, null).ok, false);
  assert.equal(consumeDenyRecord(open, undefined).ok, false);
  assert.match(consumeDenyRecord(open, '  ').error, /missing consumer session id/);
});


test('whitespace-padded consumer session id rejected (same-session class)', () => {
  const open = { session_id: 's1', ticket_id: 'T154', content_hash: 'h', status: 'open' };
  assert.equal(consumeDenyRecord(open, 's1 ').ok, false);
  assert.equal(consumeDenyRecord(open, ' s1').ok, false);
  assert.equal(consumeDenyRecord(open, 's1\t').ok, false);
  assert.match(consumeDenyRecord(open, 's1 ').error, /padded/);
});

test('cannot consume already-consumed or non-open record', () => {
  assert.equal(
    consumeDenyRecord(
      { session_id: 's1', ticket_id: 'T154', content_hash: 'h', status: 'consumed' },
      's2',
    ).ok,
    false,
  );
  assert.equal(
    consumeDenyRecord(
      { session_id: 's1', ticket_id: 'T154', content_hash: 'h', status: 'bogus' },
      's2',
    ).ok,
    false,
  );
});
