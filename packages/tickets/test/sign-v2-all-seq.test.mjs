import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { gitRepo } from '@adlc/core/test-kit';
import { recordTicketEvidence } from '../lib/evidence.mjs';
import { canonicalEntryBytes, entrySigValid, verifyManifestForest } from '../lib/manifest-primitives.mjs';
import { migrateManifestEvidence } from '../../ticket-sync/lib/reassign.mjs';

test('recordTicketEvidence signs all newly written segmented entries (seq 1 and seq >= 2) with sigVersion: 2', (t) => {
  const KEY = 'universal-signv2-key';
  const { dir: root, g } = gitRepo(t, { prefix: 'adlc-signv2-evidence-', branch: 'feat/signv2' });
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');

  const adlcDir = join(root, '.adlc');
  mkdirSync(join(adlcDir, 'manifest.d'), { recursive: true });
  writeFileSync(join(adlcDir, 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyed' }));

  const first = recordTicketEvidence(root, {
    key: KEY,
    transactionId: 'tx-1',
    operation: 'complete',
    ticketId: 'T1',
    ticketHash: 'a'.repeat(64),
    storeHash: 'b'.repeat(64),
  });
  const second = recordTicketEvidence(root, {
    key: KEY,
    transactionId: 'tx-2',
    operation: 'complete',
    ticketId: 'T2',
    ticketHash: 'c'.repeat(64),
    storeHash: 'd'.repeat(64),
  });

  assert.equal(first.seq, 1);
  assert.equal(first.sigVersion, 2);
  assert.equal(entrySigValid(KEY, first), true);

  assert.equal(second.seq, 2);
  assert.equal(second.sigVersion, 2);
  assert.equal(entrySigValid(KEY, second), true);

  const verified = verifyManifestForest(adlcDir, { key: KEY, requireSignatures: true });
  assert.equal(verified.valid, true);
  assert.equal(verified.signed, true);
  assert.equal(verified.count, 2);
});

test('migrateManifestEvidence signs all newly written segmented re-attestations (seq >= 1) with sigVersion: 2 while historical v1 entries still verify', (t) => {
  const KEY = 'universal-signv2-reassign-key';
  const { dir: root, g } = gitRepo(t, { prefix: 'adlc-signv2-reassign-', branch: 'feat/reassign-v2' });
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');

  const adlcDir = join(root, '.adlc');
  mkdirSync(join(adlcDir, 'manifest.d'), { recursive: true });
  writeFileSync(join(adlcDir, 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyed' }));

  // Seed historical v1-signed root entry (no sigVersion field)
  const v1Root = {
    seq: 1,
    gate: 'coldstart',
    ts: '2026-01-01T00:00:00.000Z',
    ticket: 'L1',
    data: { verdict: 'pass' },
    files: {},
    prev: null,
  };
  v1Root.sig = createHmac('sha256', KEY).update(canonicalEntryBytes(v1Root)).digest('hex');
  writeFileSync(join(adlcDir, 'manifest.jsonl'), `${JSON.stringify(v1Root)}\n`);

  // Record a first segment entry (seq 1) so migration appends seq 2+ to the open segment
  recordTicketEvidence(root, {
    key: KEY,
    transactionId: 'tx-open',
    operation: 'complete',
    ticketId: 'OTHER',
    ticketHash: 'e'.repeat(64),
    storeHash: 'f'.repeat(64),
  });

  const migrated = migrateManifestEvidence(root, 'L1', 'GH-42', { now: '2026-01-02T00:00:00.000Z', key: KEY });
  assert.equal(migrated.migrated, 1);
  assert.equal(migrated.entries[0].seq, 2);
  assert.equal(migrated.entries[0].sigVersion, 2);
  assert.equal(entrySigValid(KEY, migrated.entries[0]), true);

  // Both historical v1 root entry and new v2 segment entries verify together
  const verified = verifyManifestForest(adlcDir, { key: KEY, requireSignatures: true });
  assert.equal(verified.valid, true);
  assert.equal(verified.signed, true);
  assert.equal(verified.count, 3);
});
