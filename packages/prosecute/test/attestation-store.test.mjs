// Concern: attestation-store — the protected-ref mirror that closes the cross-model
// manifest TRUNCATION gap (#355, #354 F1 follow-up). Pure and gate-agnostic: no git
// awareness, no knowledge of the cross-model gate name — callers pass already-scoped
// entry arrays and a store file path.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signEntry } from '@adlc/gate-manifest/lib/sign.mjs';
import {
  readObservedAttestations,
  assertNoTruncation,
  mirrorObservedAttestations,
} from '../lib/attestation-store.mjs';

const KEY = 'test-attestation-store-key';
const WRONG_KEY = 'wrong-key';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'adlc-attestation-store-'));
}

function signedEntry(key, { seq, revision, provider = 'openai', authorProvider = 'anthropic', verdict = 'approve', prev = null }) {
  const entry = {
    seq,
    gate: 'cross-model-review',
    ts: new Date().toISOString(),
    data: { revision, provider, authorProvider, verdict },
    files: {},
    prev,
  };
  entry.sig = signEntry(key, entry);
  return entry;
}

describe('readObservedAttestations', () => {
  it('returns an empty list when the store file does not exist (bootstrap)', () => {
    const dir = tmp();
    try {
      const result = readObservedAttestations(join(dir, 'attestations.jsonl'), { key: KEY });
      assert.deepEqual(result, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns signature-verified entries from an existing store', () => {
    const dir = tmp();
    try {
      const storePath = join(dir, 'attestations.jsonl');
      const entry = signedEntry(KEY, { seq: 1, revision: 'rev-1' });
      writeFileSync(storePath, `${JSON.stringify(entry)}\n`);
      const result = readObservedAttestations(storePath, { key: KEY });
      assert.equal(result.length, 1);
      assert.equal(result[0].sig, entry.sig);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('round-5 codex finding: FAILS CLOSED (throws) rather than silently excluding an entry whose signature does not verify', () => {
    // A present-but-invalid signature in the TRUSTED STORE is either an
    // ADLC_MANIFEST_KEY rotation (every historical entry needs migrating onto the
    // new key — the same treatment this repo already gives the main manifest
    // chain, see the #364 tests) or tampering by whoever has bypass-level write
    // access to adlc-attestations. Silently treating it as "never observed" would
    // let a truncated revocation go undetected; the store must be migrated or
    // rebootstrapped, not quietly ignored.
    const dir = tmp();
    try {
      const storePath = join(dir, 'attestations.jsonl');
      const entry = signedEntry(WRONG_KEY, { seq: 1, revision: 'rev-1' });
      writeFileSync(storePath, `${JSON.stringify(entry)}\n`);
      assert.throws(() => readObservedAttestations(storePath, { key: KEY }), /signature does not verify/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns an empty list when no key is provided (nothing can be verified)', () => {
    const dir = tmp();
    try {
      const storePath = join(dir, 'attestations.jsonl');
      const entry = signedEntry(KEY, { seq: 1, revision: 'rev-1' });
      writeFileSync(storePath, `${JSON.stringify(entry)}\n`);
      const result = readObservedAttestations(storePath, { key: undefined });
      assert.deepEqual(result, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('assertNoTruncation', () => {
  it('passes when every observed signature for the revision is present in the PR entries', () => {
    const approve = signedEntry(KEY, { seq: 1, revision: 'rev-1', verdict: 'approve' });
    const result = assertNoTruncation({ prEntries: [approve], observedEntries: [approve], revision: 'rev-1', key: KEY });
    assert.deepEqual(result, { ok: true });
  });

  it('fails and names the missing signature when an observed entry is absent from the PR entries (truncation)', () => {
    const approve = signedEntry(KEY, { seq: 1, revision: 'rev-1', verdict: 'approve' });
    const revoke = signedEntry(KEY, { seq: 2, revision: 'rev-1', verdict: 'needs-attention' });
    // Truncated PR tree: only the approve remains — the revocation was dropped.
    const result = assertNoTruncation({ prEntries: [approve], observedEntries: [approve, revoke], revision: 'rev-1', key: KEY });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, [revoke.sig]);
  });

  it('is scoped per-revision — an observed entry for a different revision does not block', () => {
    const observedOther = signedEntry(KEY, { seq: 1, revision: 'rev-OTHER', verdict: 'needs-attention' });
    const prEntry = signedEntry(KEY, { seq: 1, revision: 'rev-1', verdict: 'approve' });
    const result = assertNoTruncation({ prEntries: [prEntry], observedEntries: [observedOther], revision: 'rev-1', key: KEY });
    assert.deepEqual(result, { ok: true });
  });

  it('a dropped revocation cannot be dodged by relabeling its revision (revision is signature-covered)', () => {
    const revoke = signedEntry(KEY, { seq: 2, revision: 'rev-1', verdict: 'needs-attention' });
    // Attacker submits a copy of the revoke entry relabeled to a different
    // revision — altering data.revision invalidates the original signature, so
    // the relabeled copy does not verify and cannot satisfy the subset check.
    const relabeled = { ...revoke, data: { ...revoke.data, revision: 'rev-1-different' } };
    const result = assertNoTruncation({ prEntries: [relabeled], observedEntries: [revoke], revision: 'rev-1', key: KEY });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, [revoke.sig]);
  });

  it('never throws — a wildly empty call still returns a plain result object', () => {
    assert.deepEqual(
      assertNoTruncation({ prEntries: [], observedEntries: [], revision: 'rev-1', key: KEY }),
      { ok: true },
    );
  });
});

describe('mirrorObservedAttestations', () => {
  it('bootstraps a store that does not yet exist (including missing parent directories)', () => {
    const dir = tmp();
    try {
      const storePath = join(dir, 'nested', 'attestations.jsonl');
      const entry = signedEntry(KEY, { seq: 1, revision: 'rev-1' });
      const appended = mirrorObservedAttestations({ prEntries: [entry], storePath, key: KEY });
      assert.equal(appended, 1);
      assert.ok(existsSync(storePath));
      const lines = readFileSync(storePath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0]), entry);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is idempotent — mirroring the same entries twice appends each signature only once', () => {
    const dir = tmp();
    try {
      const storePath = join(dir, 'attestations.jsonl');
      const entry = signedEntry(KEY, { seq: 1, revision: 'rev-1' });
      mirrorObservedAttestations({ prEntries: [entry], storePath, key: KEY });
      const secondRun = mirrorObservedAttestations({ prEntries: [entry], storePath, key: KEY });
      assert.equal(secondRun, 0);
      const lines = readFileSync(storePath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not mirror an entry whose signature does not verify under the given key', () => {
    const dir = tmp();
    try {
      const storePath = join(dir, 'attestations.jsonl');
      const forged = signedEntry(WRONG_KEY, { seq: 1, revision: 'rev-1' });
      const appended = mirrorObservedAttestations({ prEntries: [forged], storePath, key: KEY });
      assert.equal(appended, 0);
      assert.ok(!existsSync(storePath) || readFileSync(storePath, 'utf8').trim() === '');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('round-5 codex finding: refuses to mirror onto an EXISTING store that already contains a tampered entry (dedup must not silently mask corruption)', () => {
    const dir = tmp();
    try {
      const storePath = join(dir, 'attestations.jsonl');
      const tampered = signedEntry(WRONG_KEY, { seq: 1, revision: 'rev-1', verdict: 'needs-attention' });
      writeFileSync(storePath, `${JSON.stringify(tampered)}\n`);
      const fresh = signedEntry(KEY, { seq: 2, revision: 'rev-1', verdict: 'approve' });
      assert.throws(() => mirrorObservedAttestations({ prEntries: [fresh], storePath, key: KEY }), /signature does not verify/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('approve → revoke → truncate — the core attack this store closes', () => {
  it('mirrors an approve and its later revocation, then detects the PR branch dropping the revocation', () => {
    const dir = tmp();
    try {
      const storePath = join(dir, 'attestations.jsonl');
      const approve = signedEntry(KEY, { seq: 1, revision: 'rev-1', verdict: 'approve' });
      const revoke = signedEntry(KEY, { seq: 2, revision: 'rev-1', verdict: 'needs-attention' });

      // Trusted CI observed both entries as they landed and mirrored them.
      mirrorObservedAttestations({ prEntries: [approve, revoke], storePath, key: KEY });
      const observedEntries = readObservedAttestations(storePath, { key: KEY });
      assert.equal(observedEntries.length, 2);

      // Before truncation: the PR tree still has both entries — no truncation.
      const beforeTruncation = assertNoTruncation({ prEntries: [approve, revoke], observedEntries, revision: 'rev-1', key: KEY });
      assert.deepEqual(beforeTruncation, { ok: true });

      // Attacker truncates the manifest: drops the revocation, keeps the approve.
      // This is exactly the #354 F1 gap — a valid, shorter, validly-signed chain
      // ending in a genuine approve. The store closes it.
      const afterTruncation = assertNoTruncation({ prEntries: [approve], observedEntries, revision: 'rev-1', key: KEY });
      assert.equal(afterTruncation.ok, false);
      assert.deepEqual(afterTruncation.missing, [revoke.sig]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
