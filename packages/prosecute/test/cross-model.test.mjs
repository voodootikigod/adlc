// Concern: cross-model attestation record + check (T39 AC2, AC3-partial).
//
// recordCrossModelReview() appends a gate-manifest entry via the EXISTING chained
// record() path; hasCrossModelApprove() reads it back and is fail-closed. The gate
// is revision-bound and distinct-provider: a stale-revision or same-provider
// attestation does NOT satisfy it, and recordCrossModelReview() refuses to CREATE
// a same-provider (non cross-model) record.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { recordCrossModelReview, hasCrossModelApprove, hasCrossModelApproveForRevision } from '../lib/cross-model.mjs';
import { record } from '@adlc/gate-manifest/lib/record.mjs';
import { ledgerPath } from '@adlc/core';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'adlc-cross-model-'));
}

describe('recordCrossModelReview — fail-closed validation', () => {
  it('throws when provider equals authorProvider (not cross-model)', () => {
    const dir = tmp();
    try {
      assert.throws(
        () => recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'same', authorProvider: 'same', verdict: 'approve', dir }),
        /distinct from the author/
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('throws on missing/empty fields', () => {
    const dir = tmp();
    try {
      const base = { ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir };
      for (const field of ['ticket', 'revision', 'provider', 'authorProvider', 'verdict']) {
        assert.throws(() => recordCrossModelReview({ ...base, [field]: '' }), new RegExp(field), `empty ${field} must throw`);
        assert.throws(() => recordCrossModelReview({ ...base, [field]: undefined }), new RegExp(field), `missing ${field} must throw`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('throws on an unknown verdict', () => {
    const dir = tmp();
    try {
      assert.throws(
        () => recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'ship-it', dir }),
        /verdict/
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a same-provider record disguised by a WHITESPACE or CASE variant (normalized distinctness)', () => {
    const dir = tmp();
    try {
      // "openai " / "OpenAI" / "open ai" / fullwidth are the SAME actual provider
      // as "openai": an NFKC-fold + whitespace-strip + case-fold compare must
      // reject them all so distinctness cannot be faked with a low-effort variant.
      for (const spoof of ['openai ', ' openai', 'OpenAI', 'OPENAI', 'open ai', 'ｏｐｅｎａｉ']) {
        assert.throws(
          () => recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: spoof, authorProvider: 'openai', verdict: 'approve', dir }),
          /distinct from the author/,
          `provider="${spoof}" vs author "openai" must be rejected as non-distinct`,
        );
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('hasCrossModelApprove — round-trip and binding', () => {
  it('a distinct-provider approve bound to the current revision satisfies the gate', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'anthropic' }), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a stale-revision attestation does NOT satisfy the current revision', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-OLD', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-NEW', authorProvider: 'anthropic' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a needs-attention verdict does NOT satisfy the gate', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'needs-attention', dir });
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'anthropic' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an approve for a different ticket does NOT satisfy the gate', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T2', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'anthropic' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('author anchoring: a prosecution author EQUAL to the reviewer provider does NOT pass', () => {
    // Entry self-reports a distinct pair (openai reviewer, anthropic author), but the
    // PROSECUTION run declares its author is openai — the same as the reviewer. The
    // reviewer is therefore NOT distinct from the real author: fail closed.
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'openai' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('author anchoring: an attestation recorded for a DIFFERENT author context does NOT pass', () => {
    // Reviewer openai is distinct from the prosecution author gemini, but the record
    // was made for author anthropic, not gemini — it is not an attestation for THIS
    // author context, so it must not clear the gate.
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'gemini' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('empty manifest → false (fail-closed)', () => {
    const dir = tmp();
    try {
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'anthropic' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('missing-arg guard: no ticket/revision/authorProvider → false (fail-closed public API)', () => {
    const dir = tmp();
    try {
      assert.equal(hasCrossModelApprove({ dir }), false);
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: '', authorProvider: 'anthropic' }), false);
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1' }), false); // authorProvider omitted
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('read side rejects a FORGED whitespace-variant reviewer that equals the prosecution author (injected, bypassing the writer)', () => {
    // The writer refuses these, so inject a raw entry to prove hasCrossModelApprove
    // ALSO normalizes: reviewer "openai " is the SAME actual provider as the
    // PROSECUTION author "openai", so it must NOT clear the gate.
    const dir = tmp();
    try {
      record({ gate: 'cross-model-review', ticket: 'T1', rawData: JSON.stringify({ provider: 'openai ', authorProvider: 'anthropic', verdict: 'approve', revision: 'rev-1' }), dir });
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'openai' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('read side rejects a FORGED case-variant same-provider entry (both sides one provider, injected)', () => {
    // Entry claims reviewer "OpenAI" / author "openai" — same actual provider on
    // both sides. The write-side belt-and-suspenders (provider !== entryAuthor)
    // must reject it even normalized, independent of the prosecution author.
    const dir = tmp();
    try {
      record({ gate: 'cross-model-review', ticket: 'T1', rawData: JSON.stringify({ provider: 'OpenAI', authorProvider: 'openai', verdict: 'approve', revision: 'rev-1' }), dir });
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'anthropic' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('normalized author-anchoring: a case/whitespace variant of a genuine distinct provider STILL passes', () => {
    // The normalization must not break the honest path: "OpenAI" reviewer for an
    // "anthropic" author is genuinely distinct and must clear the gate.
    const dir = tmp();
    try {
      record({ gate: 'cross-model-review', ticket: 'T1', rawData: JSON.stringify({ provider: 'OpenAI', authorProvider: 'Anthropic', verdict: 'approve', revision: 'rev-1' }), dir });
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'anthropic' }), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the recorded entry carries provider, authorProvider, verdict and revision', () => {
    const dir = tmp();
    try {
      const entry = recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      assert.equal(entry.gate, 'cross-model-review');
      assert.equal(entry.ticket, 'T1');
      assert.deepEqual(entry.data, { provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', revision: 'rev-1' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('hasCrossModelApproveForRevision — #326 CI tier gate (ticket-agnostic)', () => {
  it('TRUE for a distinct-provider approve at the revision, regardless of the attestation ticket', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T-anything', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('FALSE when the revision does not match (stale attestation cannot clear a fresh diff)', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-OLD', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-NEW', authorProvider: 'anthropic' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('FALSE when the reviewer provider is not distinct from the run author', () => {
    const dir = tmp();
    try {
      // Recorded as openai-reviews-anthropic, but the run author is really openai → not cross-model.
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'openai' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('FALSE for a needs-attention verdict and for missing args (fail closed)', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'needs-attention', dir });
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), false);
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: '', authorProvider: 'anthropic' }), false);
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: '' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the record must be FOR this author (entry.authorProvider must equal the run author)', () => {
    const dir = tmp();
    try {
      // Reviewer gemini reviewed for author anthropic; a run claiming author openai must not be cleared.
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'gemini', authorProvider: 'anthropic', verdict: 'approve', dir });
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'openai' }), false);
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('cross-model latest-verdict revocation (#326 P5 finding)', () => {
  it('a later needs-attention from the same provider REVOKES an earlier approve (same revision)', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'needs-attention', dir });
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), false);
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'anthropic' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a later approve after a needs-attention RESTORES the gate', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'needs-attention', dir });
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a DIFFERENT provider standing approve still counts after another provider revokes', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'gemini', authorProvider: 'anthropic', verdict: 'approve', dir });
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'needs-attention', dir });
      // gemini's approve still stands.
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// #326 Codex re-review F2: a corrupted/truncated manifest line must not be silently
// dropped so that an EARLIER approve resurfaces past its revocation. readEntries()
// shunts malformed lines to `skipped` and the predicate used to ignore that field,
// so garbling a later needs-attention line (WITHOUT re-chaining — the cheap attack)
// left the approve standing. The gate now verifies the hash chain and fails CLOSED
// on any break. A determined re-author of the tail is the documented honest-limit
// (defeated only by ADLC_MANIFEST_KEY); this closes the cheap corrupt-and-skip path.
describe('cross-model manifest-tamper fail-closed (#326 Codex F2)', () => {
  it('a CORRUPTED later needs-attention line does NOT resurrect the revoked approve — fail closed', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'needs-attention', dir });
      // Sanity: the revocation is in effect before tampering.
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), false);

      // Attacker garbles the LAST line (the needs-attention) into unparseable JSON,
      // leaving the approve line untouched. readEntries would drop the garbled line
      // (→ skipped) and see only the approve; the chain no longer verifies.
      const lp = ledgerPath('manifest', dir);
      const lines = readFileSync(lp, 'utf8').split('\n');
      const idx = lines.map((l) => l.trim()).lastIndexOf(lines.map((l) => l.trim()).filter(Boolean).at(-1));
      lines[idx] = '{"seq": 2, "prev": "deadbeef", corrupt';
      writeFileSync(lp, lines.join('\n'));

      // Must stay revoked: a manifest whose chain does not verify cannot clear the gate.
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), false);
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'anthropic' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a TRUNCATED manifest (partial last line) fails closed rather than reading a stale approve', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'needs-attention', dir });
      const lp = ledgerPath('manifest', dir);
      const content = readFileSync(lp, 'utf8');
      // Chop the file mid-way through the final entry (simulates a torn write / edit).
      writeFileSync(lp, content.slice(0, content.length - 20));
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// Malformed-but-chain-valid entries (injected past recordCrossModelReview's write-side
// validation) must be IGNORED by the read-side predicate, never crash it and never be
// mistaken for a revocation. These pin the candidateReview() guards.
describe('cross-model read-side entry-shape guards (#326)', () => {
  it('an entry whose data is not an object is ignored (no crash) — guards the null-data check', () => {
    const dir = tmp();
    try {
      // rawData "null" → entry.data === null. The predicate must return early, not
      // dereference data.revision. (A same-provider real approve is present so the
      // gate would be TRUE if the null entry were merely skipped; the point here is
      // that reading it does not throw.)
      record({ gate: 'cross-model-review', ticket: 'T1', rawData: 'null', dir });
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), false);
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'anthropic' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an entry with an INVALID verdict is ignored, NOT treated as a revocation of a standing approve', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      // Inject a later same-provider entry with a bogus verdict (bypassing the writer).
      // It must be discarded by the verdict guard — the standing approve still holds.
      // If the guard were removed, this would become the "latest" verdict and wrongly
      // revoke the approve.
      record({ gate: 'cross-model-review', ticket: 'T1', rawData: JSON.stringify({ provider: 'openai', authorProvider: 'anthropic', verdict: 'bogus', revision: 'rev-1' }), dir });
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
