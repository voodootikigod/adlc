// Concern: carryForwardCrossModelReview (#365 part B) — re-attesting a verdict when the BASE
// moved but the reviewed change did not.
//
// Why it exists: binding an attestation to (base_sha, change_set_hash) is sound but makes every
// advance of `main` invalidate a verdict for an unchanged diff. Done by hand on #362 and #367
// that cost a full confirmatory review round each time. B makes it a supported operation.
//
// Why it is DANGEROUS and therefore capped: a diff can be byte-identical and semantically WRONG
// against a new base (main renames a helper it calls, or tightens a validator it relies on). If
// carry-forward were free, a verdict would ride forward over bases nobody examined — worse than
// the treadmill, which at least forced a fresh look. Premortem F1; the maintainer capped the
// chain at 3.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordCrossModelReview as realRecordCrossModelReview, carryForwardCrossModelReview as realCarryForwardCrossModelReview, CARRY_FORWARD_MAX_DEPTH,
} from '../lib/cross-model.mjs';
import { readEntries, ledgerPath, sha256 } from '@adlc/core';

process.env.ADLC_MANIFEST_KEY = 'carry-forward-test-key';

// Explicit-key wrappers (spec Layer 2): env stays set only to prove it is inert.
let currentKey = 'carry-forward-test-key';
const recordCrossModelReview = (o = {}) => realRecordCrossModelReview({ key: currentKey, ...o });
const carryForwardCrossModelReview = (o = {}) => realCarryForwardCrossModelReview({ key: currentKey, ...o });

function withoutKey(fn) {
  const prev = process.env.ADLC_MANIFEST_KEY;
  const prevCurrent = currentKey;
  currentKey = null;
  delete process.env.ADLC_MANIFEST_KEY;
  try { return fn(); } finally { currentKey = prevCurrent; if (prev === undefined) delete process.env.ADLC_MANIFEST_KEY; else process.env.ADLC_MANIFEST_KEY = prev; }
}

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-carry-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  return join(dir, '.adlc');
}
const clean = (d) => rmSync(join(d, '..'), { recursive: true, force: true });

// Two identities for the SAME reviewed change against DIFFERENT bases.
const DIGEST = 'a'.repeat(64);
const rev = (base) => `git-change:${base}:${DIGEST}`;
const BASE1 = '1'.repeat(40);
const BASE2 = '2'.repeat(40);
const BASE3 = '3'.repeat(40);
const BASE4 = '4'.repeat(40);
const BASE5 = '5'.repeat(40);

const seed = (dir, revision, over = {}) => recordCrossModelReview({
  ticket: 'T1', revision, provider: 'agy', authorProvider: 'anthropic', verdict: 'approve', dir, ...over,
});
const carry = (dir, fromRevision, revision) => carryForwardCrossModelReview({
  ticket: 'T1', fromRevision, revision, dir,
});
const lastEntry = (dir) => readEntries('manifest', dir).entries.at(-1);

// Hand-build a segment file directly, same pattern as cross-model.test.mjs's
// writeCrossModelSegment (the segment WRITER is T-MANIFEST-FOREST slice 3, not
// yet built). A needs-attention entry does not need a signature (spec §6).
function writeRevocationSegment(dir, name, { ticket, revision }) {
  const lines = readFileSync(ledgerPath('manifest', dir), 'utf8').split('\n').filter((l) => l.trim());
  const last = lines.at(-1);
  const anchor = { segment: 'root', seq: JSON.parse(last).seq, lineHash: sha256(last) };
  const entry = {
    seq: 1,
    gate: 'cross-model-review',
    ts: '2026-01-01T00:00:00.000Z',
    ticket,
    data: { provider: 'openai', authorProvider: 'anthropic', verdict: 'needs-attention', revision },
    files: {},
    prev: null,
    anchor,
  };
  const segDir = join(dir, 'manifest.d');
  mkdirSync(segDir, { recursive: true });
  writeFileSync(join(segDir, name), JSON.stringify(entry) + '\n');
}

describe('carryForwardCrossModelReview (#365 B)', () => {
  it('carries a verdict forward when only the base moved, and records the link and depth', () => {
    const dir = ledger();
    try {
      seed(dir, rev(BASE1));
      carry(dir, rev(BASE1), rev(BASE2));
      const e = lastEntry(dir);
      assert.equal(e.data.verdict, 'approve');
      assert.equal(e.data.revision, rev(BASE2));
      assert.equal(e.data.carriedFrom, rev(BASE1), 'the ledger must show which verdict was carried');
      assert.equal(e.data.carryDepth, 1, 'depth must be visible so an Nth-hand verdict is auditable');
      // The verdict is the SAME one — provider distinctness is inherited, not re-asserted.
      assert.equal(e.data.provider, 'agy');
      assert.equal(e.data.authorProvider, 'anthropic');
    } finally { clean(dir); }
  });

  // F1 / AC10 — computed, not asserted.
  it('refuses when the reviewed change itself differs, even if the caller claims otherwise', () => {
    const dir = ledger();
    try {
      seed(dir, rev(BASE1));
      const altered = `git-change:${BASE2}:${'b'.repeat(64)}`;
      assert.throws(() => carry(dir, rev(BASE1), altered), /change/i,
        'a different change set must never be carried forward');
      assert.equal(readEntries('manifest', dir).entries.length, 1, 'nothing may be appended on refusal');
    } finally { clean(dir); }
  });

  it('refuses when there is no prior verdict to carry', () => {
    const dir = ledger();
    try {
      assert.throws(() => carry(dir, rev(BASE1), rev(BASE2)), /no .*(prior|approve)/i);
    } finally { clean(dir); }
  });

  // Adversarial-review finding (agy, #365): latestEntryForRevision() searched only by revision,
  // not ticket, so an approval genuinely earned for one ticket could be carried forward as if it
  // were a DIFFERENT ticket's own — smuggling a distinct-provider review that never happened for
  // the sensitive ticket. Scoped by ticket now; this pins the fix.
  it('refuses to carry a DIFFERENT ticket\'s approval forward, even at the identical revision string', () => {
    const dir = ledger();
    try {
      // T1 earns a genuine approval at BASE1.
      seed(dir, rev(BASE1));
      // T2 has NEVER been reviewed at BASE1 — carrying "forward" for T2 must not find T1's entry.
      assert.throws(
        () => carryForwardCrossModelReview({ ticket: 'T2', fromRevision: rev(BASE1), revision: rev(BASE2), dir }),
        /no prior cross-model verdict recorded/,
        'T2 must not be able to smuggle T1\'s approval as its own'
      );
      // Sanity: T1 itself can still carry forward normally — the refusal is ticket-scoped, not
      // a blanket break.
      carry(dir, rev(BASE1), rev(BASE2));
      assert.equal(lastEntry(dir).ticket, 'T1');
    } finally { clean(dir); }
  });

  // Adversarial-review finding (agy, #365): carryForwardCrossModelReview read the prior entry
  // straight from readEntries() without verifying its HMAC signature — the SAME defense the
  // read-side gate (candidateReview / hasCrossModelApprove) already requires before trusting an
  // entry. The manifest lives in the PR-controlled tree, so an attacker can append an UNSIGNED,
  // structurally-valid "approve" naming a real ticket and revision; without this check,
  // carry-forward would find it, treat it as a legitimate prior verdict, and mint a BRAND NEW,
  // VALIDLY SIGNED entry carrying it forward — laundering a forged claim into a real attestation
  // through whoever holds the signing key when carry-forward runs (e.g. in CI).
  it('refuses to carry forward an UNSIGNED (forged) prior entry, even though it is structurally a valid approve', () => {
    const dir = ledger();
    try {
      // The forge: a distinct-provider "approve" for a real ticket/revision, written WITHOUT
      // the key — no valid signature, exactly what an unprivileged PR author can produce.
      withoutKey(() => seed(dir, rev(BASE1)));
      assert.throws(
        () => carry(dir, rev(BASE1), rev(BASE2)),
        /not signature-verified/,
        'an unsigned prior entry must never be laundered into a signed carried-forward one'
      );
      assert.equal(readEntries('manifest', dir).entries.length, 1, 'the refused carry must not append anything');
    } finally { clean(dir); }
  });

  it('refuses to carry forward a prior entry signed with a DIFFERENT (attacker-controlled) key', () => {
    const dir = ledger();
    try {
      // Explicit keys per call (spec Layer 2): the attacker seeds under THEIR key;
      // the carry attempt runs under the real one. No env mutation involved.
      seed(dir, rev(BASE1), { key: 'attacker-controlled-key' });
      // A present-but-wrong-key signature is TAMPERING (#354 F1), which the chain check itself
      // already rejects — either refusal reason is correct; what matters is that it refuses.
      assert.throws(() => carry(dir, rev(BASE1), rev(BASE2)), /not signature-verified|manifest hash chain does not verify/);
    } finally { clean(dir); }
  });

  it('refuses to carry forward with NO signing key available, even for a genuinely-signed prior entry', () => {
    const dir = ledger();
    try {
      seed(dir, rev(BASE1)); // genuinely signed with the real key
      assert.throws(
        () => withoutKey(() => carry(dir, rev(BASE1), rev(BASE2))),
        /no signing key available/
      );
    } finally { clean(dir); }
  });

  // Adversarial-review finding (agy, #365): depth was computed from whatever entry `fromRevision`
  // happened to name, so a caller could bypass CARRY_FORWARD_MAX_DEPTH by naming an EARLIER,
  // low-depth entry in the same ticket's history instead of the chain's actual current head.
  it('refuses to carry forward from a STALE (non-latest) entry, even one within the depth cap', () => {
    const dir = ledger();
    try {
      seed(dir, rev(BASE1)); // depth 0 (undefined)
      carry(dir, rev(BASE1), rev(BASE2)); // depth 1
      carry(dir, rev(BASE2), rev(BASE3)); // depth 2 — this is now T1's actual chain head
      // Attempt to carry from the ORIGINAL rev(BASE1) entry instead of the true head rev(BASE3).
      // If depth were computed from rev(BASE1) (undefined -> 0), this would succeed at depth 1,
      // silently resetting the cap instead of refusing.
      assert.throws(
        () => carry(dir, rev(BASE1), rev(BASE4)),
        /is not the latest recorded cross-model entry/,
        'carrying from a stale entry must be refused outright, not silently accepted at a reset depth'
      );
      assert.equal(readEntries('manifest', dir).entries.length, 3, 'the refused carry must not append anything');
      // Sanity: carrying from the TRUE head still works normally.
      carry(dir, rev(BASE3), rev(BASE4));
      assert.equal(lastEntry(dir).data.carryDepth, 3);
    } finally { clean(dir); }
  });

  // F1 — the cap is the whole safeguard.
  it(`caps the chain at ${CARRY_FORWARD_MAX_DEPTH}: the next carry-forward is refused`, () => {
    const dir = ledger();
    try {
      seed(dir, rev(BASE1));
      carry(dir, rev(BASE1), rev(BASE2));
      carry(dir, rev(BASE2), rev(BASE3));
      carry(dir, rev(BASE3), rev(BASE4));
      assert.equal(lastEntry(dir).data.carryDepth, 3);
      assert.throws(() => carry(dir, rev(BASE4), rev(BASE5)), /depth|fresh|cap/i,
        'the 4th carry-forward must demand a fresh distinct-provider review');
      assert.equal(readEntries('manifest', dir).entries.length, 4, 'the refused carry must not append');
    } finally { clean(dir); }
  });

  it('a fresh review RESETS the chain, so depth counts consecutive carries only', () => {
    const dir = ledger();
    try {
      seed(dir, rev(BASE1));
      carry(dir, rev(BASE1), rev(BASE2));
      carry(dir, rev(BASE2), rev(BASE3));
      // A genuine new review against BASE4 — not a carry.
      seed(dir, rev(BASE4));
      carry(dir, rev(BASE4), rev(BASE5));
      assert.equal(lastEntry(dir).data.carryDepth, 1, 'a fresh review must reset the chain');
    } finally { clean(dir); }
  });

  // A legacy whole-worktree identity has no change-set component, so "the change did not move"
  // is not a question that can be answered about it.
  it('refuses to carry a legacy git-worktree identity forward', () => {
    const dir = ledger();
    try {
      seed(dir, 'git-worktree:' + 'f'.repeat(64));
      assert.throws(() => carry(dir, 'git-worktree:' + 'f'.repeat(64), rev(BASE2)), /change-set|git-change|legacy/i);
    } finally { clean(dir); }
  });

  it('refuses to carry a non-approve verdict forward', () => {
    const dir = ledger();
    try {
      recordCrossModelReview({
        ticket: 'T1', revision: rev(BASE1), provider: 'agy', authorProvider: 'anthropic',
        verdict: 'needs-attention', dir,
      });
      assert.throws(() => carry(dir, rev(BASE1), rev(BASE2)), /approve/i);
    } finally { clean(dir); }
  });

  // Adversarial-review finding (T-MANIFEST-FOREST slice 2, PR #389 rebase round):
  // this function's "latest entry" lookup is root-only (see the comment above it in
  // cross-model.mjs), but a revocation for fromRevision can legitimately live in a
  // SEGMENT (spec §6 — an out-of-band flag, or a migration cutover seal) even before
  // slice 3's writer exists, the same way the read-side gate's own forest-walk tests
  // hand-build segments today. Without a forest-wide revocation check, carry-forward
  // would miss the segment's needs-attention entry entirely, find the still-present
  // root approve, and mint a FRESH, validly-signed approve for the new revision —
  // resurrecting a verdict the reviewer explicitly revoked.
  it('refuses to carry forward fromRevision if it has been revoked in a SEGMENT, not just root', () => {
    const dir = ledger();
    try {
      seed(dir, rev(BASE1)); // approve for T1 @ BASE1, in root
      writeRevocationSegment(dir, 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl', { ticket: 'T1', revision: rev(BASE1) });
      assert.throws(
        () => carry(dir, rev(BASE1), rev(BASE2)),
        /revoked/i,
        'a segment-recorded revocation of fromRevision must block carry-forward, not just root ones'
      );
      assert.equal(readEntries('manifest', dir).entries.length, 1, 'the refused carry must not append anything to root');
    } finally { clean(dir); }
  });
});
