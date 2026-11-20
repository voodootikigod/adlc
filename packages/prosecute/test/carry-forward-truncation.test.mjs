// Concern: truncation anchor must cover carry-forward chains — a dropped carriedFrom ancestor
// or a dropped same-change-set needs-attention (under a different base) must fail closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEntries } from '@adlc/core';
import { signEntry } from '@adlc/gate-manifest/lib/sign.mjs';
import { assertNoTruncation } from '../lib/attestation-store.mjs';
import {
  recordCrossModelReview,
  carryForwardCrossModelReview,
  hasCrossModelApproveForRevision,
  evaluateCrossModelRevision,
} from '../lib/cross-model.mjs';

const KEY = 'carry-forward-truncation-test-key';
const DIGEST = 'b'.repeat(64);
const rev = (base) => `git-change:${base}:${DIGEST}`;
const BASE1 = '1'.repeat(40);
const BASE2 = '2'.repeat(40);
const BASE3 = '3'.repeat(40);

function signedEntry({ seq, revision, verdict = 'approve', carriedFrom, ticket = 'T1' }) {
  const data = { revision, provider: 'openai', authorProvider: 'anthropic', verdict };
  if (carriedFrom) data.carriedFrom = carriedFrom;
  const entry = { seq, gate: 'cross-model-review', ticket, ts: new Date().toISOString(), data, files: {}, prev: null };
  entry.sig = signEntry(KEY, entry);
  return entry;
}

function withLedger(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-carry-trunc-'));
  try {
    const dir = join(root, '.adlc');
    mkdirSync(dir, { recursive: true });
    return fn(dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('assertNoTruncation and hasCrossModelApproveForRevision fail closed when carriedFrom ancestor or same-digest needs-attention entry is truncated from PR manifest', () => {
  // Pure assertNoTruncation: a dropped carriedFrom ancestor is named.
  const ancestor = signedEntry({ seq: 1, revision: rev(BASE1) });
  const carried = signedEntry({ seq: 2, revision: rev(BASE2), carriedFrom: rev(BASE1) });
  const ok = assertNoTruncation({ prEntries: [ancestor, carried], observedEntries: [ancestor, carried], revision: rev(BASE2), key: KEY });
  assert.deepEqual(ok, { ok: true });
  const truncatedAncestor = assertNoTruncation({ prEntries: [carried], observedEntries: [ancestor, carried], revision: rev(BASE2), key: KEY });
  assert.equal(truncatedAncestor.ok, false);
  assert.deepEqual(truncatedAncestor.missing, [ancestor.sig]);

  // A tampered PR entry carrying ancestor's stolen sig string still counts as missing under ticket scoping.
  const tamperedAncestor = { ...ancestor, data: { ...ancestor.data, verdict: 'needs-attention' } };
  assert.equal(
    assertNoTruncation({ prEntries: [tamperedAncestor, carried], observedEntries: [ancestor, carried], revision: rev(BASE2), key: KEY, ticket: 'T1' }).ok,
    false,
  );

  // Multi-hop carriedFrom chain where the intermediate link only exists in observedEntries still walks back to root ancestor.
  const hop2 = signedEntry({ seq: 20, revision: rev(BASE2), carriedFrom: rev(BASE1) });
  const hop3 = signedEntry({ seq: 21, revision: rev(BASE3), carriedFrom: rev(BASE2) });
  const multiHopTrunc = assertNoTruncation({ prEntries: [hop3], observedEntries: [ancestor, hop2, hop3], revision: rev(BASE3), key: KEY, ticket: 'T1' });
  assert.equal(multiHopTrunc.ok, false);
  assert.deepEqual(multiHopTrunc.missing, [ancestor.sig, hop2.sig]);

  // A dropped needs-attention for the SAME change-set digest under a DIFFERENT base is named too.
  const revoke = signedEntry({ seq: 3, revision: rev(BASE3), verdict: 'needs-attention' });
  const truncatedRevoke = assertNoTruncation({ prEntries: [ancestor, carried], observedEntries: [ancestor, carried, revoke], revision: rev(BASE2), key: KEY });
  assert.equal(truncatedRevoke.ok, false);
  assert.deepEqual(truncatedRevoke.missing, [revoke.sig]);

  // An unrelated change-set's needs-attention does not block.
  const other = signedEntry({ seq: 4, revision: `git-change:${BASE3}:${'c'.repeat(64)}`, verdict: 'needs-attention' });
  assert.deepEqual(
    assertNoTruncation({ prEntries: [ancestor, carried], observedEntries: [other], revision: rev(BASE2), key: KEY }),
    { ok: true },
  );

  // End to end through the gate predicate.
  withLedger((dir) => {
    recordCrossModelReview({ ticket: 'T1', revision: rev(BASE1), provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir, key: KEY });
    carryForwardCrossModelReview({ ticket: 'T1', fromRevision: rev(BASE1), revision: rev(BASE2), dir, key: KEY });
    const manifest = readEntries('manifest', dir).entries;
    const gate = (observedEntries) => hasCrossModelApproveForRevision({ dir, revision: rev(BASE2), authorProvider: 'anthropic', key: KEY, observedEntries });
    assert.equal(gate(undefined), true);
    assert.equal(gate(manifest), true);
    assert.equal(gate([...manifest, signedEntry({ seq: 90, revision: rev(BASE1), provider: 'google' })]), false, 'a signed ancestor entry absent from the PR manifest');
    assert.equal(gate([...manifest, revoke]), false, 'a signed same-digest needs-attention absent from the PR manifest');

    // A separate ticket T2's approval by the same author in observedEntries does NOT accuse T1 of truncation,
    // while a truncated needs-attention revocation from T2 on the same change-set still fails closed.
    const t2Approve = signedEntry({ seq: 95, ticket: 'T2', revision: rev(BASE2), provider: 'google' });
    assert.equal(gate([...manifest, t2Approve]), true, 'same-author approval from unrelated ticket T2 does not falsely trigger truncation on T1');
    assert.deepEqual(
      evaluateCrossModelRevision({ prEntries: manifest, observedEntries: [...manifest, t2Approve], revision: rev(BASE2), authorProvider: 'anthropic', key: KEY }),
      { satisfied: true, truncationDetected: false },
    );
    assert.deepEqual(
      evaluateCrossModelRevision({ prEntries: manifest, observedEntries: [...manifest, signedEntry({ seq: 96, ticket: 'T2', revision: rev(BASE2), verdict: 'needs-attention' })], revision: rev(BASE2), authorProvider: 'anthropic', key: KEY }),
      { satisfied: false, truncationDetected: true },
    );
    assert.deepEqual(
      evaluateCrossModelRevision({ prEntries: manifest, observedEntries: [...manifest], revision: rev(BASE2), authorProvider: 'anthropic', key: KEY, ticket: 'T1' }),
      { satisfied: true, truncationDetected: false },
    );
    assert.deepEqual(
      evaluateCrossModelRevision({ prEntries: manifest, observedEntries: [...manifest, signedEntry({ seq: 97, ticket: 'T1', revision: rev(BASE1), provider: 'google' })], revision: rev(BASE2), authorProvider: 'anthropic', key: KEY, ticket: 'T1' }),
      { satisfied: false, truncationDetected: true },
    );
    assert.deepEqual(
      evaluateCrossModelRevision({ prEntries: [], observedEntries: [t2Approve], revision: rev(BASE2), authorProvider: 'anthropic', key: KEY }),
      { satisfied: false, truncationDetected: true },
    );
    assert.deepEqual(
      evaluateCrossModelRevision({ prEntries: [signedEntry({ seq: 99, ticket: 'T1', revision: rev(BASE1) })], observedEntries: [], revision: rev(BASE2), authorProvider: 'anthropic', key: KEY }),
      { satisfied: false, truncationDetected: false },
    );

    // Unticketed (legacy/cutover) signed approvals remain valid when ticket is omitted, while unticketed truncation still fails closed
    const unticketedData = { revision: rev(BASE2), provider: 'openai', authorProvider: 'anthropic', verdict: 'approve' };
    const unticketedApprove = { seq: 101, gate: 'cross-model-review', ts: new Date().toISOString(), data: unticketedData, files: {}, prev: null };
    unticketedApprove.sig = signEntry(KEY, unticketedApprove);
    const unticketedCarry = { seq: 102, gate: 'cross-model-review', ts: new Date().toISOString(), data: { ...unticketedData, revision: rev(BASE3), carriedFrom: rev(BASE2) }, files: {}, prev: null };
    unticketedCarry.sig = signEntry(KEY, unticketedCarry);
    assert.deepEqual(
      evaluateCrossModelRevision({ prEntries: [unticketedApprove], observedEntries: [unticketedApprove], revision: rev(BASE2), authorProvider: 'anthropic', key: KEY }),
      { satisfied: true, truncationDetected: false },
    );
    assert.deepEqual(
      evaluateCrossModelRevision({ prEntries: [unticketedCarry], observedEntries: [unticketedApprove, unticketedCarry], revision: rev(BASE3), authorProvider: 'anthropic', key: KEY }),
      { satisfied: false, truncationDetected: true },
    );
  });
});

test('carryForwardCrossModelReview throws when observedEntries contains revoked or truncated ancestor', () => {
  const refused = /cannot carry forward: prior or same-digest attestation was truncated or revoked in attestation store/;
  withLedger((dir) => {
    recordCrossModelReview({ ticket: 'T1', revision: rev(BASE1), provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir, key: KEY });
    const manifest = readEntries('manifest', dir).entries;
    const carry = (observedEntries) => carryForwardCrossModelReview({ ticket: 'T1', fromRevision: rev(BASE1), revision: rev(BASE2), dir, key: KEY, observedEntries });

    // Truncated: the store holds a signed entry for fromRevision the manifest lacks.
    assert.throws(() => carry([...manifest, signedEntry({ seq: 90, revision: rev(BASE1), provider: 'google' })]), refused);
    // Revoked: the store holds a needs-attention for this ticket + same digest under another base.
    assert.throws(() => carry([...manifest, signedEntry({ seq: 91, revision: rev(BASE3), verdict: 'needs-attention' })]), refused);
    // A different ticket's observed entry at the same revision does NOT block T1's carry-forward.
    const otherTicketEntry = signedEntry({ seq: 92, ticket: 'T2', revision: rev(BASE1), provider: 'google' });
    // Nothing was carried by the refused attempts; a clean or cross-ticket store lets T1's carry through.
    assert.equal(readEntries('manifest', dir).entries.length, manifest.length);
    const carried = carry([...manifest, otherTicketEntry]);
    assert.equal(carried.data.carriedFrom, rev(BASE1));
  });
});
