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
import { recordCrossModelReview, hasCrossModelApprove } from '../lib/cross-model.mjs';
import { record } from '@adlc/gate-manifest/lib/record.mjs';

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
