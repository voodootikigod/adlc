import { ensureDenyMarker, loadDenyRecords, mutationGateInputFromLoad } from '../lib/deny-marker.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
      resumeAuth: {
        ticket_id: 'T154',
        content_hash: 'abc',
        verified: true,
        deny_session_id: 's1',
      },
    }),
    true,
  );
  assert.equal(
    authorized({
      record: open(),
      resumeAuth: {
        ticket_id: 'T154',
        content_hash: 'abc',
        verified: true,
        deny_session_id: 'other',
      },
    }),
    false,
  );
  assert.equal(
    authorized({
      record: open(),
      resumeAuth: { ticket_id: 'T154', content_hash: 'WRONG', verified: true, deny_session_id: 's1' },
    }),
    false,
  );
  assert.equal(
    authorized({
      record: open(),
      resumeAuth: { ticket_id: 'OTHER', content_hash: 'abc', verified: true, deny_session_id: 's1' },
    }),
    false,
  );
  assert.equal(
    authorized({
      record: open(),
      resumeAuth: { ticket_id: 'T154', content_hash: 'abc', verified: true },
    }),
    false,
    'missing deny_session_id',
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

test('legacy true bypass does NOT authorize unbound open records', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: [open({ ticket_id: null, content_hash: null })],
    bypassForSession: true,
  });
  assert.equal(g.deny, true);
  assert.ok(g.reasons.some((r) => r.startsWith('D3')));
});

test('unboundReason grant authorizes unbound open for non-denier', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: [open({ ticket_id: null, content_hash: null })],
    bypassForSession: { unboundReason: 'operator-override' },
  });
  assert.equal(g.deny, false);
});

test('legacy true bypass still authorizes bound open and lifts D2', () => {
  const g = evaluateMutationGate({
    currentSessionId: 's1',
    denyRecords: [open()],
    bypassForSession: true,
  });
  assert.equal(g.deny, false);
  assert.ok(!g.reasons.some((r) => r.startsWith('D2')));
});

test('empty unboundReason is not a bypass grant', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: [open({ ticket_id: null, content_hash: null })],
    bypassForSession: { unboundReason: '  ' },
  });
  assert.equal(g.deny, true);
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
    resumeAuth: {
      ticket_id: 'T154',
      content_hash: 'abc',
      verified: true,
      deny_session_id: 's1',
    },
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
    resumeAuth: {
      ticket_id: 'T154',
      content_hash: 'abc',
      verified: true,
      deny_session_id: 's3',
    },
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
    resumeAuth: {
      ticket_id: 'T154',
      content_hash: 'h1',
      verified: true,
      deny_session_id: 'a',
    },
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


test('missing/empty/padded currentSessionId fail-closed', () => {
  const consumed = open({ status: 'consumed' });
  for (const id of [undefined, null, '', '  ', 's1 ']) {
    const g = evaluateMutationGate({
      currentSessionId: id,
      denyRecords: [consumed],
      resumeAuth: null,
    });
    assert.equal(g.deny, true, `expected deny for currentSessionId=${JSON.stringify(id)}`);
    assert.ok(g.reasons.includes('D0:invalid_session_id'));
  }
});

test('path-separator and traversal sessionIds fail-closed D0', () => {
  for (const id of ['a/b', '../x', 'a\\b', '..', 'foo/../bar']) {
    const g = evaluateMutationGate({
      currentSessionId: id,
      denyRecords: [],
      resumeAuth: null,
    });
    assert.equal(g.deny, true, `expected deny for currentSessionId=${JSON.stringify(id)}`);
    assert.ok(g.reasons.includes('D0:invalid_session_id'));
  }
});

test('single-character currentSessionId is usable (D0 off-by-one)', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'a',
    denyRecords: [],
  });
  assert.equal(g.deny, false);
  assert.deepEqual(g.reasons, []);
});

test('invalid/missing status fails closed under D3 for every session', () => {
  for (const status of ['revoked', 'bogus', null, undefined]) {
    const record = open({ session_id: 'denier' });
    if (status === undefined) delete record.status;
    else record.status = status;
    for (const sid of ['denier', 'fresh']) {
      const g = evaluateMutationGate({
        currentSessionId: sid,
        denyRecords: [record],
        resumeAuth: null,
      });
      assert.equal(g.deny, true, `status=${JSON.stringify(status)} sid=${sid}`);
      assert.ok(g.reasons.some((r) => r.startsWith('D3:invalid_record:')), g.reasons.join(','));
    }
  }
});

test('consumed status is valid and does not participate in D3', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: [open({ status: 'consumed' })],
  });
  assert.equal(g.deny, false);
});

test('bypass + manifestVerifyFailed does not authorize', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: [open()],
    bypassForSession: true,
    manifestVerifyFailed: true,
  });
  assert.equal(g.deny, true);
  assert.ok(g.reasons.some((r) => r.startsWith('D3')));
});

test('bypass + manifestVerifyFailed does not lift D2', () => {
  const g = evaluateMutationGate({
    currentSessionId: 's1',
    denyRecords: [open()],
    bypassForSession: true,
    manifestVerifyFailed: true,
  });
  assert.equal(g.deny, true);
  assert.ok(g.reasons.includes('D2:denier_session'));
});

test('authorized() rejects when manifestVerifyFailed even with bypass', () => {
  assert.equal(
    authorized({
      record: open(),
      bypassForSession: true,
      manifestVerifyFailed: true,
    }),
    false,
  );
});

test('non-array denyRecords fails closed D0', () => {
  for (const bad of [null, {}, 'x', 1]) {
    const g = evaluateMutationGate({
      currentSessionId: 'fresh',
      denyRecords: bad,
    });
    assert.equal(g.deny, true, JSON.stringify(bad));
    assert.ok(g.reasons.includes('D0:invalid_deny_records'));
  }
});

test('denyStoreUnavailable fails closed D0', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: [],
    denyStoreUnavailable: true,
  });
  assert.equal(g.deny, true);
  assert.ok(g.reasons.includes('D0:deny_store_unavailable'));
});

test('resume-auth deny_session_id does not authorize a different open deny', () => {
  const records = [
    open({ session_id: 'a', content_hash: 'h' }),
    open({ session_id: 'b', content_hash: 'h' }),
  ];
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: records,
    resumeAuth: {
      ticket_id: 'T154',
      content_hash: 'h',
      verified: true,
      deny_session_id: 'a',
    },
  });
  assert.equal(g.deny, true);
  assert.ok(g.reasons.some((r) => r.includes('b')));
  assert.ok(!g.reasons.some((r) => r.includes(':a')));
});



test('bypass grant for another sessionId does not authorize', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: [open()],
    bypassForSession: { sessionId: 'other', unboundReason: 'operator-override' },
  });
  assert.equal(g.deny, true);
});

test('falsy denyRecords entries fail closed', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: [null, open({ status: 'consumed' })],
  });
  assert.equal(g.deny, true);
  assert.ok(g.reasons.includes('D3:invalid_record:?'));
});


test('empty object / array bypassForSession is not a bypass', () => {
  for (const bad of [{}, [], 'yes', 1]) {
    const g = evaluateMutationGate({
      currentSessionId: 's1',
      denyRecords: [open()],
      bypassForSession: bad,
    });
    assert.equal(g.deny, true, JSON.stringify(bad));
    assert.ok(g.reasons.some((r) => r.startsWith('D2') || r.startsWith('D3')));
  }
});

test('unboundReason lifts D0:deny_store_unavailable; legacy true does not', () => {
  const base = {
    currentSessionId: 'op',
    denyRecords: [],
    denyStoreUnavailable: true,
  };
  const denied = evaluateMutationGate({ ...base, bypassForSession: true });
  assert.equal(denied.deny, true);
  assert.ok(denied.reasons.includes('D0:deny_store_unavailable'));
  const lifted = evaluateMutationGate({
    ...base,
    bypassForSession: { unboundReason: 'host-repair' },
  });
  assert.equal(lifted.deny, false);
  assert.ok(!lifted.reasons.includes('D0:deny_store_unavailable'));
});

test('composed load after handoffs wipe: unbound clears D0 without sticky D3', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    ensureDenyMarker(root, { sessionId: 's1', ticketId: 'T154', contentHash: 'h' });
    rmSync(join(root, '.adlc', 'handoffs'), { recursive: true, force: true });
    const loaded = loadDenyRecords(root);
    assert.equal(loaded.denyStoreUnavailable, true);
    const input = mutationGateInputFromLoad(loaded, { currentSessionId: 'op' });
    assert.equal(input.denyStoreUnavailable, true);
    assert.ok(!input.denyRecords.some((r) => r.session_id === '__deny_store__'));
    const denied = evaluateMutationGate({ ...input, bypassForSession: true });
    assert.equal(denied.deny, true);
    assert.ok(denied.reasons.includes('D0:deny_store_unavailable'));
    assert.ok(!denied.reasons.some((r) => r.startsWith('D3:invalid_record:__deny_store__')));
    const lifted = evaluateMutationGate({
      ...input,
      bypassForSession: { unboundReason: 'operator-override' },
    });
    assert.equal(lifted.deny, false, JSON.stringify(lifted.reasons));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unboundReason clears D3:invalid_record for corrupt foreign marker', () => {
  const g = evaluateMutationGate({
    currentSessionId: 'op',
    denyRecords: [{ session_id: 'ghost', status: 'invalid:corrupt_json' }],
    bypassForSession: { unboundReason: 'host-repair' },
  });
  assert.equal(g.deny, false);
  assert.ok(!g.reasons.some((r) => r.startsWith('D3:invalid_record')));
});
