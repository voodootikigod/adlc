import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorized, evaluateMutationGate } from '../lib/mutation-gate.mjs';

const open = (over = {}) => ({
  session_id: 's1',
  ticket_id: 'T154',
  content_hash: 'abc',
  status: 'open',
  ...over,
});

test('null-ticket never authorized via resume-auth', () => {
  assert.equal(
    authorized({
      record: open({ ticket_id: null }),
      resumeAuth: { ticket_id: 'T154', content_hash: 'abc', verified: true },
    }),
    false,
  );
});

test('null-hash never authorized via resume-auth', () => {
  assert.equal(
    authorized({
      record: open({ content_hash: null }),
      resumeAuth: { ticket_id: 'T154', content_hash: 'abc', verified: true },
    }),
    false,
  );
});

test('empty-string ticket_id/content_hash never authorized via resume-auth', () => {
  assert.equal(
    authorized({
      record: open({ ticket_id: '', content_hash: '' }),
      resumeAuth: { ticket_id: '', content_hash: '', verified: true },
    }),
    false,
  );
  assert.equal(
    authorized({
      record: open({ ticket_id: '  ', content_hash: 'abc' }),
      resumeAuth: { ticket_id: '  ', content_hash: 'abc', verified: true },
    }),
    false,
  );
});

test('authorized requires matching ticket_id and content_hash', () => {
  assert.equal(
    authorized({
      record: open(),
      resumeAuth: { ticket_id: 'T154', content_hash: 'abc', verified: true },
    }),
    true,
  );
  assert.equal(
    authorized({
      record: open(),
      resumeAuth: { ticket_id: 'T154', content_hash: 'WRONG', verified: true },
    }),
    false,
  );
  assert.equal(
    authorized({
      record: open(),
      resumeAuth: { ticket_id: 'OTHER', content_hash: 'abc', verified: true },
    }),
    false,
  );
});

test('authorized(null record) === false', () => {
  assert.equal(authorized({ record: null }), false);
  assert.equal(authorized({}), false);
});

test('verified:false resume-auth does not authorize', () => {
  assert.equal(
    authorized({
      record: open(),
      resumeAuth: { ticket_id: 'T154', content_hash: 'abc', verified: false },
    }),
    false,
  );
});

test('bypassForSession lifts D2 for denier', () => {
  const g = evaluateMutationGate({
    currentSessionId: 's1',
    denyRecords: [open()],
    bypassForSession: true,
  });
  assert.equal(g.deny, false);
  assert.ok(!g.reasons.some((r) => r.startsWith('D2')));
});

test('bypass authorizes null-ticket/null-hash open for non-denier', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: [open({ ticket_id: null, content_hash: null })],
    bypassForSession: true,
  });
  assert.equal(g.deny, false);
});

test('bypass does NOT lift D1', () => {
  const g = evaluateMutationGate({
    processStickyDeny: true,
    currentSessionId: 's1',
    denyRecords: [open()],
    bypassForSession: true,
  });
  assert.equal(g.deny, true);
  assert.ok(g.reasons.includes('D1:process_sticky'));
  assert.ok(!g.reasons.some((r) => r.startsWith('D2')));
});

test('D2: denier session always denied even with resume-auth', () => {
  const g = evaluateMutationGate({
    currentSessionId: 's1',
    denyRecords: [open()],
    resumeAuth: { ticket_id: 'T154', content_hash: 'abc', verified: true },
  });
  assert.equal(g.deny, true);
  assert.ok(g.reasons.some((r) => r.startsWith('D2')));
});

test('D3: fresh session denied without auth for open record', () => {
  const g = evaluateMutationGate({
    currentSessionId: 's2',
    denyRecords: [open()],
    resumeAuth: null,
  });
  assert.equal(g.deny, true);
  assert.ok(g.reasons.some((r) => r.startsWith('D3')));
});

test('D3 cleared for ONLY consumed records WITHOUT resume-auth', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: [open({ session_id: 's1', status: 'consumed' })],
    resumeAuth: null,
  });
  assert.equal(g.deny, false);
  assert.deepEqual(g.reasons, []);
});

test('D3 cleared for consumed record when other open denies authorized', () => {
  const records = [
    open({ session_id: 's1', status: 'consumed' }),
    open({ session_id: 's3', ticket_id: 'T154', content_hash: 'abc', status: 'open' }),
  ];
  const g = evaluateMutationGate({
    currentSessionId: 's2',
    denyRecords: records,
    resumeAuth: { ticket_id: 'T154', content_hash: 'abc', verified: true },
  });
  assert.equal(g.deny, false);
});

test('multi-open-deny: must authorize every open record', () => {
  const records = [
    open({ session_id: 'a', content_hash: 'h1' }),
    open({ session_id: 'b', content_hash: 'h2' }),
  ];
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: records,
    resumeAuth: { ticket_id: 'T154', content_hash: 'h1', verified: true },
  });
  assert.equal(g.deny, true);
  assert.ok(g.reasons.some((r) => r.includes('b')));
});

test('wrong-hash resume-auth does not authorize', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: [open()],
    resumeAuth: { ticket_id: 'T154', content_hash: 'WRONG', verified: true },
  });
  assert.equal(g.deny, true);
  assert.ok(g.reasons.some((r) => r.startsWith('D3')));
});

test('wrong-ticket resume-auth does not authorize', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: [open()],
    resumeAuth: { ticket_id: 'OTHER', content_hash: 'abc', verified: true },
  });
  assert.equal(g.deny, true);
  assert.ok(g.reasons.some((r) => r.startsWith('D3')));
});

test('manifest verify failure treats resume-auth as absent', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: [open()],
    resumeAuth: { ticket_id: 'T154', content_hash: 'abc', verified: true },
    manifestVerifyFailed: true,
  });
  assert.equal(g.deny, true);
});

test('D1 process sticky', () => {
  const g = evaluateMutationGate({
    processStickyDeny: true,
    currentSessionId: 'x',
    denyRecords: [],
  });
  assert.equal(g.deny, true);
  assert.ok(g.reasons.includes('D1:process_sticky'));
});
