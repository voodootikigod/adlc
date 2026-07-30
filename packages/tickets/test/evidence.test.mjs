import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTicketStore, TicketService, recordTicketEvidence, withManifestLock } from '../index.mjs';
import { ticket, writeDirectory } from './helpers.mjs';

test('sensitive mutations append signed dual-hash evidence and retries are idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-evidence-'));
  const previous = process.env.ADLC_MANIFEST_KEY;
  process.env.ADLC_MANIFEST_KEY = 'test-manifest-key';
  try {
    const store = new DirectoryTicketStore(writeDirectory(root, [ticket('A')]));
    const service = new TicketService(store, { root, protectedIds: ['A'], key: 'test-manifest-key' });
    const after = service.apply(service.planComplete('A', { authorized: true }));
    const path = join(root, '.adlc/manifest.jsonl');
    const [line] = readFileSync(path, 'utf8').trim().split('\n');
    const entry = JSON.parse(line);
    assert.equal(entry.ticket, 'A');
    assert.equal(entry.data.ticketHash, after.ticketHashes.A);
    assert.equal(entry.data.storeHash, after.hash);
    assert.equal(entry.data.bindingScope, 'ticket');
    const canonical = { seq: entry.seq, gate: entry.gate, ts: entry.ts, ticket: entry.ticket, data: entry.data, files: entry.files, prev: entry.prev };
    assert.equal(entry.sig, createHmac('sha256', 'test-manifest-key').update(JSON.stringify(canonical)).digest('hex'));
    recordTicketEvidence(root, { ...entry.data, ticketId: entry.ticket, key: 'test-manifest-key' });
    assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1);
    assert.throws(
      () => recordTicketEvidence(root, { ...entry.data, ticketId: entry.ticket, storeHash: '0'.repeat(64), key: 'test-manifest-key' }),
      (error) => error.code === 'EVIDENCE_IDEMPOTENCY_CONFLICT',
    );
  } finally {
    if (previous === undefined) delete process.env.ADLC_MANIFEST_KEY;
    else process.env.ADLC_MANIFEST_KEY = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('an old manifest lock is never stolen from a potentially live owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-evidence-lock-'));
  try {
    const manifest = join(root, '.adlc/manifest.jsonl');
    const lock = `${manifest}.lock`;
    mkdirSync(join(root, '.adlc'));
    writeFileSync(lock, JSON.stringify({ token: 'existing-owner', pid: 1 }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    assert.throws(
      () => withManifestLock(manifest, () => assert.fail('must not enter'), { retries: 0, delayMs: 0 }),
      (error) => error.code === 'MANIFEST_LOCK_TIMEOUT',
    );
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'existing-owner');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
