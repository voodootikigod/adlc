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
});

describe('hasCrossModelApprove — round-trip and binding', () => {
  it('a distinct-provider approve bound to the current revision satisfies the gate', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1' }), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a stale-revision attestation does NOT satisfy the current revision', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-OLD', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-NEW' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a needs-attention verdict does NOT satisfy the gate', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'needs-attention', dir });
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an approve for a different ticket does NOT satisfy the gate', () => {
    const dir = tmp();
    try {
      recordCrossModelReview({ ticket: 'T2', revision: 'rev-1', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1' }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('empty manifest → false (fail-closed)', () => {
    const dir = tmp();
    try {
      assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-1' }), false);
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
