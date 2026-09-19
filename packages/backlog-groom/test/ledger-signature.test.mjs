// ledger-signature.test.mjs — the ledger is authorization, so it must be
// unforgeable (#1035).
//
// `planAction` refuses anything the ledger does not approve, precisely so a
// caller-supplied `gate` field cannot authorize itself. But every field
// `ledgerApproves` checked was one the caller could compute — `artifactDigest`
// is an exported pure function of the action — so writing one JSON object into
// .adlc/backlog-groom-ledger.json bought a comment and a close with no review.
//
// These tests are about what the ledger GRANTS, not about the HMAC as such:
// each one asks "does this entry authorize a write?", which is the question the
// defect answered wrongly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { signLedgerEntry, verifyLedgerEntry } from '../lib/ledger-sig.mjs';
import { ledgerApproves, gateKey, artifactDigest, gateAction } from '../lib/gate.mjs';
import { executeActions } from '../lib/execute.mjs';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

const action = {
  number: 705,
  action: 'close',
  contentHash: 'h1',
  evidence: 'the cited line is gone',
  field: null,
};

/** The entry `gateAction` records for an approved action, correctly signed. */
function approvedEntry(key = KEY, overrides = {}) {
  const entry = {
    verdict: 'approve',
    reason: null,
    reviewer: 'openai',
    decider: 'anthropic',
    contentHash: action.contentHash,
    number: action.number,
    action: action.action,
    field: action.field ?? null,
    artifactDigest: artifactDigest(action),
    ...overrides,
  };
  entry.sig = signLedgerEntry(key, entry);
  return entry;
}

const ledgerWith = (entry) => ({ [gateKey(action)]: entry });

test('AC1: a hand-written entry with no signature grants nothing', () => {
  // Exactly the forgery: every field the old check looked at, none of them
  // secret. `artifactDigest` is exported and pure, so the caller can compute it.
  const forged = approvedEntry();
  delete forged.sig;

  assert.equal(ledgerApproves(ledgerWith(forged), action, KEY), false);
});

test('AC2: an entry edited after signing fails verification', () => {
  for (const [field, value] of [
    ['verdict', 'approve'],
    ['number', 999],
    ['contentHash', 'h2'],
    ['artifactDigest', 'deadbeef'],
    ['action', 'relabel'],
  ]) {
    // Sign a DEMOTE, then flip the field — the shape of a caller upgrading
    // their own refusal, or moving an approval onto another issue.
    const entry = approvedEntry(KEY, { verdict: 'demote', reason: 'the reviewer raised a material finding' });
    entry[field] = value;
    assert.equal(verifyLedgerEntry(KEY, entry), false, `editing ${field} must invalidate the signature`);
    assert.equal(ledgerApproves(ledgerWith(entry), action, KEY), false, `editing ${field} must grant nothing`);
  }
});

test('AC2: an entry signed with a different key grants nothing', () => {
  assert.equal(ledgerApproves(ledgerWith(approvedEntry(OTHER_KEY)), action, KEY), false);
});

test('a correctly signed approval still authorizes', () => {
  // The negative tests above are only meaningful if the positive one holds:
  // otherwise "grants nothing" would pass with the gate wired shut.
  assert.equal(ledgerApproves(ledgerWith(approvedEntry()), action, KEY), true);
});

test('AC1: no key means no authorization, even for a validly signed entry', () => {
  // Writes are a key-holder act. Without one the tool proposes and never closes.
  assert.equal(ledgerApproves(ledgerWith(approvedEntry()), action, null), false);
  assert.equal(ledgerApproves(ledgerWith(approvedEntry()), action, undefined), false);
});

test('AC6: verifyLedgerEntry returns false rather than throwing on malformed input', () => {
  const entry = approvedEntry();
  for (const sig of [undefined, null, '', 42, {}, [], 'not-hex', 'a'.repeat(63), 'a'.repeat(65)]) {
    assert.equal(verifyLedgerEntry(KEY, { ...entry, sig }), false, `sig ${JSON.stringify(sig)} must not verify`);
  }
  assert.equal(verifyLedgerEntry(KEY, null), false);
  assert.equal(verifyLedgerEntry(KEY, undefined), false);
  assert.equal(verifyLedgerEntry(null, entry), false);
  assert.equal(verifyLedgerEntry('', entry), false);
});

test('AC4: a forged applied flag does not short-circuit into a reported execution', () => {
  // `applied: true` makes executeActions skip the write and report the action as
  // already done. Unsigned, that is a way to have the tool announce a close it
  // never performed — and to suppress the retry that would have performed it.
  const forged = approvedEntry();
  forged.applied = true; // after signing: the signature no longer covers it
  const gh = {
    comments: () => [],
    comment: () => { throw new Error('must not comment'); },
    apply: () => { throw new Error('must not write'); },
  };

  const result = executeActions({
    actions: [action],
    floor: [],
    baseFloor: [],
    ledger: ledgerWith(forged),
    gh,
    key: KEY,
  });

  assert.deepEqual(result.executed, [], 'a forged applied flag must not read as an execution');
  assert.equal(result.demoted.length, 1);
  assert.equal(result.demoted[0].reason, 'gate');
});

test('a signed applied flag is honoured, so a resumed run does not repeat the write', () => {
  // The positive control for AC4: the short-circuit must still work when the
  // entry legitimately carries it, or a crashed run would redo its mutation.
  const entry = approvedEntry(KEY, { applied: true });
  const gh = {
    comments: () => [],
    comment: () => { throw new Error('must not comment'); },
    apply: () => { throw new Error('must not write'); },
  };

  const result = executeActions({
    actions: [action],
    floor: [],
    baseFloor: [],
    ledger: ledgerWith(entry),
    gh,
    key: KEY,
  });

  assert.equal(result.executed.length, 1);
  assert.equal(result.executed[0].alreadyApplied, true);
});

test('the signature is over content, not key order: a nested object signs the same either way', () => {
  // Canonicalisation has to be recursive. If nested objects were stringified as
  // they came, the same entry written by two code paths could canonicalise
  // differently and a legitimate approval would fail to verify.
  const a = { verdict: 'approve', gate: { reviewer: 'openai', decider: 'anthropic' }, number: 7 };
  const b = { number: 7, gate: { decider: 'anthropic', reviewer: 'openai' }, verdict: 'approve' };

  assert.equal(signLedgerEntry(KEY, a), signLedgerEntry(KEY, b));
  assert.equal(verifyLedgerEntry(KEY, { ...a, sig: signLedgerEntry(KEY, b) }), true);
});

test('a differing nested value still changes the signature', () => {
  // The other half: order-insensitive must not mean content-insensitive.
  const a = { verdict: 'approve', gate: { reviewer: 'openai' } };
  const b = { verdict: 'approve', gate: { reviewer: 'anthropic' } };
  assert.notEqual(signLedgerEntry(KEY, a), signLedgerEntry(KEY, b));
});

test('a short key is still a key', () => {
  // The guard rejects an ABSENT key, not a short one. Rejecting by length would
  // silently refuse to verify entries this same code signed.
  const entry = { verdict: 'approve', number: 7 };
  assert.equal(verifyLedgerEntry('k', { ...entry, sig: signLedgerEntry('k', entry) }), true);
});

test('AC5: gateAction demotes with a REASON when no key is available, and spawns no review', () => {
  // Not null, and not a thrown error: the run reports why each action demoted,
  // and the caller reads `verdict`. Returning null would make every consumer's
  // `gate?.verdict` undefined and the reason unreportable.
  for (const noKey of [null, undefined, '']) {
    const out = gateAction({
      action,
      profile: { providers: { decider: 'anthropic', reviewer: 'openai' } },
      ledger: {},
      runReview: () => { throw new Error('a review must not be spawned without a key'); },
      key: noKey,
    });
    assert.equal(out.verdict, 'demote', `key ${JSON.stringify(noKey)} must demote`);
    // The EXACT no-key reason, not merely something mentioning a key: a run that
    // fell through and failed inside the reviewer also reports a reason, and
    // matching loosely would accept that as if the guard had fired.
    assert.match(out.reason, /no signing key is available/i, `key ${JSON.stringify(noKey)} must report the missing key`);
  }
});

test('no key leaves the ledger untouched, so the run that has one is not refused as a replay', () => {
  // Recording a verdict would burn the one-shot: the revision would read as
  // already gated, and the key-holder's run would be refused.
  for (const noKey of [null, undefined, '']) {
    const ledger = {};
    gateAction({ action, profile: { providers: { decider: 'anthropic', reviewer: 'openai' } }, ledger, runReview: () => ({ code: 0 }), key: noKey });
    assert.deepEqual(ledger, {}, `key ${JSON.stringify(noKey)} must leave the ledger untouched`);
  }
});
