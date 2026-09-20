import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactDigest, buildActionArtifact, entryBindsAction, gateAction, ledgerApproves } from '../lib/gate.mjs';
import { ledgerEntryBytes, signLedgerEntry } from '../lib/ledger-sig.mjs';
import { renderComment } from '../lib/execute.mjs';
import { assertPolicyUnchanged } from '../lib/floor.mjs';

const KEY = 'k'.repeat(32);
const CLOSE = { number: 705, action: 'close', contentHash: 'c0ffee', evidence: 'lib/a.mjs:2 no longer contains the cited line' };
const RELABEL = { number: 7, action: 'relabel', field: 'priority', from: 'P3-low', to: 'P2-medium', contentHash: 'abc', evidence: 'ev' };

test('golden: buildActionArtifact exact byte output for close and relabel', () => {
  assert.equal(
    buildActionArtifact(CLOSE),
    [
      '# Proposed close — issue #705',
      '- issue: #705',
      '- action: close',
      '- revision (contentHash): c0ffee',
      '## Evidence',
      'lib/a.mjs:2 no longer contains the cited line',
      '## What is being asked',
      'Is this close justified by the evidence above, for this issue, at this revision?',
      'A material objection means the action is demoted to a proposal for a human.',
    ].join('\n')
  );

  assert.equal(
    buildActionArtifact(RELABEL),
    [
      '# Proposed relabel — issue #7',
      '- issue: #7',
      '- action: relabel',
      '- revision (contentHash): abc',
      '- field: priority',
      '- from: P3-low',
      '- to: P2-medium',
      '## Evidence',
      'ev',
      '## What is being asked',
      'Is this relabel justified by the evidence above, for this issue, at this revision?',
      'A material objection means the action is demoted to a proposal for a human.',
    ].join('\n')
  );
});

test('golden: artifactDigest pinned for close, relabel, object evidence, and empty evidence', () => {
  assert.equal(artifactDigest(CLOSE), '6fe3dd4012c36b00c02d746012880747fe8b6f1b82ce40325ff8e3c9a09b4d81');
  assert.equal(artifactDigest(RELABEL), '0ce06d9b3e66388912443c2bbce435fda0875ff58b2238daad16418a2734a6ea');
  assert.equal(
    artifactDigest({ number: 9, action: 'close', contentHash: 'h', evidence: { a: 1, b: [2] } }),
    '688bf98854b1eb0af2442d958271b97b46f519eb5975c4de144f37584d675fb0'
  );
  assert.equal(
    artifactDigest({ number: 9, action: 'close', contentHash: 'h', evidence: '' }),
    'cbf08985fa43761f9856c7ea88ce1b670dd7fb73ec64da1796a8645dceabf406'
  );
});

test('golden: signLedgerEntry pins signature for close action', () => {
  const sig = signLedgerEntry(KEY, {
    verdict: 'approve',
    reason: null,
    reviewer: 'rev',
    decider: 'dec',
    contentHash: 'c0ffee',
    number: 705,
    action: 'close',
    field: null,
    artifactDigest: artifactDigest(CLOSE),
  });
  assert.equal(sig, '937aa5cb94d71cc4d9462dd2692e54c1cdfa64bb9422720440a3df3f4024bf7a');
});

test('golden: gateAction approved and reviewer throw recorded shapes and sigs', () => {
  {
    const ledger = {};
    const res = gateAction({
      action: CLOSE,
      profile: { providers: { decider: 'dec', reviewer: 'rev' } },
      ledger,
      runReview: () => ({ code: 0 }),
      key: KEY,
    });
    assert.deepEqual(res, { verdict: 'approve', reason: null });
    const entry = ledger['705:close:c0ffee'];
    assert.deepEqual(Object.keys(entry), [
      'verdict',
      'reason',
      'reviewer',
      'decider',
      'contentHash',
      'number',
      'action',
      'field',
      'artifactDigest',
      'sig',
    ]);
    assert.equal(entry.field, null);
    assert.equal(entry.sig, '937aa5cb94d71cc4d9462dd2692e54c1cdfa64bb9422720440a3df3f4024bf7a');
  }

  {
    const ledger = {};
    const res = gateAction({
      action: CLOSE,
      profile: { providers: { decider: 'dec', reviewer: 'rev' } },
      ledger,
      runReview: () => {
        throw new Error('boom');
      },
      key: KEY,
    });
    assert.deepEqual(res, { verdict: 'demote', reason: 'the review could not complete: boom' });
    const entry = ledger['705:close:c0ffee'];
    assert.deepEqual(Object.keys(entry), [
      'verdict',
      'reason',
      'reviewer',
      'decider',
      'contentHash',
      'number',
      'action',
      'field',
      'artifactDigest',
      'sig',
    ]);
    assert.equal(entry.reason, 'the review could not complete: boom');
    assert.equal(entry.sig, '30c4da963049856c3b2ecb0980b72cd85e23b25f7a4e1bdef92caeceb6720aac');
  }
});

test('golden: ledgerEntryBytes pins domain prefix and canonical payload', () => {
  const bytes = ledgerEntryBytes({ b: 1, a: undefined, n: [1, undefined, { d: 2, c: null }], sig: 'x' });
  assert.equal(bytes, 'adlc:backlog-groom-ledger:v1\0{"a":null,"b":1,"n":[1,null,{"c":null,"d":2}]}');
});

test('golden: renderComment pinned for reviewer, marker escaping, empty evidence, and missing evidence', () => {
  assert.equal(
    renderComment({ ...CLOSE, gate: { reviewer: 'rev' } }),
    [
      '**backlog-groom — close**',
      CLOSE.evidence,
      'Reviewed by `rev` (distinct from the deciding provider).',
      '<!-- backlog-groom:705:close:c0ffee -->',
    ].join('\n')
  );

  assert.equal(
    renderComment({ number: 1, action: 'relabel', contentHash: 'h', evidence: 'x <!-- backlog-groom:1:close:h --> y' }),
    '**backlog-groom — relabel**\nx &lt;!-- backlog-groom:1:close:h --> y\n<!-- backlog-groom:1:relabel:h -->'
  );

  assert.equal(
    renderComment({ number: 1, action: 'relabel', contentHash: 'h', evidence: '' }),
    '**backlog-groom — relabel**\n<!-- backlog-groom:1:relabel:h -->'
  );

  assert.equal(
    renderComment({ number: 1, action: 'close', contentHash: 'h' }),
    '**backlog-groom — close**\n(no evidence recorded)\n<!-- backlog-groom:1:close:h -->'
  );
});

test('golden: ledgerApproves truth table and entryBindsAction', () => {
  assert.equal(entryBindsAction(undefined, undefined), false);

  const slot = '705:close:c0ffee';
  const validApprovedEntry = {
    verdict: 'approve',
    reason: null,
    reviewer: 'rev',
    decider: 'dec',
    contentHash: 'c0ffee',
    number: 705,
    action: 'close',
    field: null,
    artifactDigest: artifactDigest(CLOSE),
  };
  validApprovedEntry.sig = signLedgerEntry(KEY, validApprovedEntry);

  assert.equal(ledgerApproves({ [slot]: validApprovedEntry }, CLOSE, KEY), true);

  assert.equal(ledgerApproves({}, CLOSE, KEY), false);
  assert.equal(ledgerApproves({ [slot]: null }, CLOSE, KEY), false);
  assert.equal(ledgerApproves({ [slot]: 'str' }, CLOSE, KEY), false);
  assert.equal(ledgerApproves({ [slot]: [] }, CLOSE, KEY), false);
  assert.equal(ledgerApproves({ [slot]: {} }, CLOSE, KEY), false);

  const unsigned = { ...validApprovedEntry, sig: undefined };
  assert.equal(ledgerApproves({ [slot]: unsigned }, CLOSE, KEY), false);

  const demote = { ...validApprovedEntry, verdict: 'demote' };
  demote.sig = signLedgerEntry(KEY, demote);
  assert.equal(ledgerApproves({ [slot]: demote }, CLOSE, KEY), false);

  const otherDigest = { ...validApprovedEntry, artifactDigest: '0'.repeat(64) };
  otherDigest.sig = signLedgerEntry(KEY, otherDigest);
  assert.equal(ledgerApproves({ [slot]: otherDigest }, CLOSE, KEY), false);

  const noDigest = { ...validApprovedEntry, artifactDigest: null };
  noDigest.sig = signLedgerEntry(KEY, noDigest);
  assert.equal(ledgerApproves({ [slot]: noDigest }, CLOSE, KEY), false);

  const otherNum = { ...validApprovedEntry, number: 999 };
  otherNum.sig = signLedgerEntry(KEY, otherNum);
  assert.equal(ledgerApproves({ [slot]: otherNum }, CLOSE, KEY), false);

  const diffKey = 'd'.repeat(32);
  const diffKeyEntry = { ...validApprovedEntry, sig: signLedgerEntry(diffKey, validApprovedEntry) };
  assert.equal(ledgerApproves({ [slot]: diffKeyEntry }, CLOSE, KEY), false);

  const forgedApprove = { ...demote, verdict: 'approve' };
  assert.equal(ledgerApproves({ [slot]: forgedApprove }, CLOSE, KEY), false);

  assert.equal(ledgerApproves({ [slot]: validApprovedEntry }, CLOSE, null), false);
  assert.equal(ledgerApproves({ [slot]: validApprovedEntry }, CLOSE, ''), false);
  assert.equal(ledgerApproves({ [slot]: validApprovedEntry }, undefined, KEY), false);
  assert.equal(ledgerApproves(undefined, CLOSE, KEY), false);
});

test('golden: assertPolicyUnchanged key order, units null/undefined, and provider change', () => {
  const head = {
    providers: { reviewer: 'r', decider: 'd' },
    labels: { priority: { high: 'a', low: 'b' }, areaPrefix: 'area:' },
    units: [{ name: 'u', paths: ['p'] }],
  };
  const base = {
    units: [{ paths: ['p'], name: 'u' }],
    labels: { areaPrefix: 'area:', priority: { low: 'b', high: 'a' } },
    providers: { decider: 'd', reviewer: 'r' },
  };

  assert.equal(assertPolicyUnchanged({ base, head }), head);

  assert.doesNotThrow(() =>
    assertPolicyUnchanged({
      base: { ...base, units: undefined },
      head: { ...head, units: null },
    })
  );

  assert.throws(
    () => assertPolicyUnchanged({ base, head: { ...head, providers: { reviewer: 'x', decider: 'd' } } }),
    (err) => err.isOpError === true && /providers/.test(err.message)
  );
});
