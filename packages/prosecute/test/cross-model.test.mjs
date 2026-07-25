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
import { ledgerPath, sha256 } from '@adlc/core';

// #326 hardening: attestations are HMAC-signed and the readers verify the signature
// (which signs when the key is present) and the readers both need it set. Set it for this
// file; the forge-resistance block below toggles it deliberately to exercise the no-key and
// wrong-key paths.
const KEY = 'test-cross-model-signing-key';
process.env.ADLC_MANIFEST_KEY = KEY;

function withoutKey(fn) {
  const prev = process.env.ADLC_MANIFEST_KEY;
  delete process.env.ADLC_MANIFEST_KEY;
  try { return fn(); } finally { if (prev === undefined) delete process.env.ADLC_MANIFEST_KEY; else process.env.ADLC_MANIFEST_KEY = prev; }
}

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

// #326 forge resistance — the attestation lives in the PR-controlled manifest, so the gate
// must trust it ONLY via a signature under the key (a secret the PR author does not hold).
// This is the complement to the manifest-tamper block above: chain integrity stops a dropped
// revocation; signature verification stops a fabricated, well-chained approve.
describe('signature verification (#326 — a PR author cannot forge an approve)', () => {
  it('an UNSIGNED approve (the forge: attacker appends data with no sig) is REJECTED', () => {
    const dir = tmp();
    try {
      // Simulate the forge: a distinct-provider `approve` for the exact revision, but written
      // WITHOUT the key so it carries no valid signature — a PR author's fabricated line.
      withoutKey(() => recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir }));
      // The reader (with the key) refuses it: no valid signature ⇒ not a candidate.
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), false);
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'anthropic' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an approve signed with a DIFFERENT key (attacker signs with their own) is REJECTED', () => {
    const dir = tmp();
    const prev = process.env.ADLC_MANIFEST_KEY;
    try {
      process.env.ADLC_MANIFEST_KEY = 'attacker-controlled-key';
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      process.env.ADLC_MANIFEST_KEY = prev; // back to the real (CI) key
      // Verified against the real key, the wrong-key signature does not match ⇒ rejected.
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), false);
    } finally { process.env.ADLC_MANIFEST_KEY = prev; rmSync(dir, { recursive: true, force: true }); }
  });

  it('NO key at read time fails closed, even for a genuinely-signed attestation', () => {
    const dir = tmp();
    try {
      // A real, correctly-signed attestation…
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      // …is still untrusted when the reader has no key to verify with (fork-PR / misconfig).
      assert.equal(withoutKey(() => hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' })), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// #326 — the gate must stay FUNCTIONAL on a real manifest. The shared ledger accumulates
// entries from every gate, most recorded before signing was enabled, so they are unsigned.
// A full sig-requiring chain check would fail on the first such entry and make the gate
// permanently inert (fail-closed for EVERY PR, valid attestation or not — which just gets
// bypassed and enforces nothing). The chain check is therefore chain-only; forge resistance
// is enforced per-entry on the specific approve. These two tests pin BOTH halves.
describe('cross-model works on an unsigned legacy manifest (#326 — not inert, still forge-proof)', () => {
  it('a SIGNED approve IS trusted even when earlier manifest entries are UNSIGNED', () => {
    const dir = tmp();
    try {
      // Legacy history: other gates' entries recorded before signing existed → unsigned.
      withoutKey(() => {
        record({ gate: 'build-gate', ticket: 'T0', rawData: JSON.stringify({ ok: true }), dir });
        record({ gate: 'rails', ticket: 'T0', rawData: JSON.stringify({ ok: true }), dir });
      });
      // Then a properly-signed cross-model approve for the current revision.
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      // Gate PASSES: chain-only tolerates the unsigned history; the approve itself is signed.
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), true);
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'anthropic' }), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an UNSIGNED approve amid unsigned history is REJECTED — per-entry forge resistance survives chain-only', () => {
    const dir = tmp();
    try {
      withoutKey(() => {
        record({ gate: 'build-gate', ticket: 'T0', rawData: JSON.stringify({ ok: true }), dir });
        // The forge: an unsigned approve, structurally identical to a real one. Chain-only
        // verify accepts the chain (it does not demand sigs), so the ONLY thing standing
        // between this forge and a pass is candidateReview's per-entry signature check.
        recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      });
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), false);
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'anthropic' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// #326 — hasCrossModelApprove is the per-TICKET gate; each argument of its input guard is
// an independent fail-closed requirement. A MISSING ticket in particular must refuse, and
// must NOT fall through to the ticket-agnostic match (which would accept ANY revision-bound
// approve). This pins the `!ticket` clause as load-bearing — a weakened guard that let a
// missing ticket through would silently downgrade the per-ticket gate to ticket-agnostic.
describe('hasCrossModelApprove input guard is fail-closed per clause (#326)', () => {
  it('a missing ticket fails closed even when a valid signed approve for the revision exists', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      // Sanity: WITH the ticket it passes — so the approve is genuinely valid and the
      // false below is due to the guard, not a broken fixture.
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1', authorProvider: 'anthropic' }), true);
      // WITHOUT a ticket the per-ticket gate must refuse, not match ticket-agnostically.
      assert.equal(hasCrossModelApprove({ dir, ticket: undefined, revision: 'rev-1', authorProvider: 'anthropic' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// #354 Codex F1 (rewrite half): an author who controls the manifest could REWRITE a signed
// `needs-attention` revocation so it no longer matches the gate, invalidating its sig, and
// recompute the public prev-hashes so the chain still links. Chain-only verify must NOT wave
// that through — a present-but-invalid signature is tampering, not "unsigned history". (The
// truncation half — dropping the revocation entirely — is a documented honest-limit closed by
// branch protection; see manifestChainTrustworthy.)
describe('cross-model rewrite-a-signed-revocation is caught (#354 F1)', () => {
  it('tampering a signed needs-attention (invalidating its sig) keeps the gate FAILED, not resurrected', () => {
    const dir = tmp();
    try {
      // A distinct reviewer approves R, then revokes R with needs-attention (both signed).
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'needs-attention', dir });
      // A later unrelated signed entry, so the revocation is not the last line (the attacker
      // must recompute a downstream prev-hash — exactly the scenario in the finding).
      record({ gate: 'build-gate', ticket: 'T1', rawData: JSON.stringify({ ok: true }), dir });
      // Sanity: the revocation stands → gate is already false, so the assertion below is
      // proving the TAMPER is rejected, not merely that an approve is absent.
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), false);

      const lp = ledgerPath('manifest', dir);
      const lines = readFileSync(lp, 'utf8').split('\n').filter((l) => l.trim());
      const b = JSON.parse(lines[1]);
      assert.equal(b.data.verdict, 'needs-attention');
      assert.ok(b.sig, 'the revocation is signed');
      b.data = { ...b.data, verdict: 'bogus' }; // no longer a revocation candidate; sig now stale
      lines[1] = JSON.stringify(b);
      const c = JSON.parse(lines[2]);
      c.prev = sha256(lines[1]); // relink so the hash chain itself is intact
      lines[2] = JSON.stringify(c);
      writeFileSync(lp, lines.join('\n') + '\n');

      // Must STILL fail closed: the tampered entry's present-but-invalid signature is rejected
      // by verify(), so the neutralized revocation cannot resurrect the earlier approve.
      assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider: 'anthropic' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
