// Re-attestation entries written by `ticket-sync reassign` are signed with the
// shared canonicalisation in @adlc/tickets, so every verifier (gate-manifest,
// rails-guard, the forest reader) accepts them. Round-trips each signing
// version through the shared verifier, and forbids a private twin of the
// canonical bytes, which could drift from the verifiers unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmp } from '@adlc/core/test-kit';
import { entrySigValid, canonicalEntryBytes, recordTicketEvidence, resolveOpenSegment, segmentPath } from '@adlc/tickets';
import { migrateManifestEvidence } from '../lib/reassign.mjs';

const KEY = 'shared-signing-key';

function signedSource() {
  const source = { seq: 1, gate: 'prosecution', ts: '2026-01-01T00:00:00Z', ticket: 'T7', data: { verdict: 'clear' }, files: {}, prev: null };
  return { ...source, sig: createHmac('sha256', KEY).update(canonicalEntryBytes(source)).digest('hex') };
}

function memoryLedger(initial) {
  const lines = initial.map((e) => JSON.stringify(e));
  return {
    appendBatch: (_name, factory) => {
      const additions = factory({ entries: lines.map((l) => JSON.parse(l)), skipped: [], rawLines: [...lines], lastRawLine: lines.at(-1) ?? null });
      lines.push(...additions.map((e) => JSON.stringify(e)));
      return additions;
    },
  };
}

test('a v1 re-attestation verifies under the shared entrySigValid', () => {
  const ledger = memoryLedger([signedSource()]);
  const r = migrateManifestEvidence('/repo', 'T7', 'gh:acme/app#2', { now: '2026-06-27T00:00:00Z', key: KEY, appendBatch: ledger.appendBatch });
  assert.equal(r.migrated, 1);
  const [entry] = r.entries;
  assert.equal(entry.sigVersion, undefined);
  assert.equal(entrySigValid(KEY, entry), true);
  assert.equal(entrySigValid('other-key', entry), false);
  assert.equal(entrySigValid(KEY, { ...entry, data: { ...entry.data, verdict: 'blocked' } }), false);
});

test('a v2 anchor-carrying re-attestation verifies under the shared entrySigValid', (t) => {
  const root = tmp(t, 'reassign-v2-');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q', '-b', 'feat/shared-signing');
  git('config', 'user.email', 't@t.co');
  git('config', 'user.name', 'tester');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const dir = join(root, '.adlc');
  mkdirSync(dir, { recursive: true });
  recordTicketEvidence(root, {
    transactionId: 'tx-1', operation: 'complete', ticketId: 'T7',
    ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: KEY,
  });
  mkdirSync(join(dir, 'manifest.d'), { recursive: true });
  writeFileSync(join(dir, 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));

  const r = migrateManifestEvidence(root, 'T7', 'gh:acme/app#3', { now: '2026-06-27T00:00:00Z', key: KEY });
  assert.equal(r.migrated, 1);
  const resolved = resolveOpenSegment(dir, { cwd: root });
  const first = JSON.parse(readFileSync(segmentPath(dir, resolved.name), 'utf8').trim().split('\n')[0]);
  assert.equal(first.sigVersion, 2);
  assert.equal(entrySigValid(KEY, first), true);
  assert.equal(entrySigValid(KEY, { ...first, anchor: 'forged' }), false, 'v2 covers the anchor');
});

test('reassign.mjs keeps no private copy of the signed-entry canonicalisation', () => {
  const src = readFileSync(new URL('../lib/reassign.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /function\s+canonicalEntryBytes\b/);
  assert.doesNotMatch(src, /function\s+signV2\b/);
  assert.match(src, /\bcanonicalEntryBytes\b[\s\S]*from '@adlc\/tickets'/);
});
