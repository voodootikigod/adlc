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

test('null/missing record cannot consume', () => {
  assert.equal(consumeDenyRecord(null, 's2').ok, false);
  assert.equal(consumeDenyRecord(undefined, 's2').ok, false);
  assert.match(consumeDenyRecord(null, 's2').error, /missing deny record/);
});
