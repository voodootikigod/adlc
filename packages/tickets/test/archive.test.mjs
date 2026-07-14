import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTicketStore, archiveTicket, pendingTransactions, recoverDirectoryTransaction, restoreTicket, ticketFilename, ticketHash } from '../index.mjs';
import { ticket, writeDirectory } from './helpers.mjs';

test('archive blocks inbound edges and restore verifies metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-archive-'));
  try {
    const path = writeDirectory(root, [ticket('A'), ticket('B', { edges: [{ to: 'A' }] })]);
    const store = new DirectoryTicketStore(path);
    assert.throws(() => archiveTicket(store, join(root, '.adlc/ticket-archive'), 'A', { root, authorized: true }), (error) => error.code === 'ARCHIVE_INBOUND_EDGE');
    const result = archiveTicket(store, join(root, '.adlc/ticket-archive'), 'B', { root, authorized: true, reason: 'done' });
    assert.equal(result.active.get('B'), undefined);
    assert.equal(result.archived._adlcArchive.ticketHash, ticketHash(ticket('B', { edges: [{ to: 'A' }] })));
    const restored = restoreTicket(store, join(root, '.adlc/ticket-archive'), 'B', { root, authorized: true });
    assert.equal(restored.active.get('B').id, 'B');
    assert.equal(restored.ticket._adlcArchive, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('archive and restore rollback covers both active and archive stores', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-archive-recovery-'));
  try {
    const activePath = writeDirectory(root, [ticket('A')]);
    const active = new DirectoryTicketStore(activePath);
    const archivePath = join(root, '.adlc/ticket-archive');
    assert.throws(() => archiveTicket(active, archivePath, 'A', {
      expectedSnapshotHash: active.load().hash,
      root,
      authorized: true,
      faultInjector: (step) => { if (step === 'operation-applied:2') throw new Error('fault'); },
    }), /fault/);
    let [transactionId] = pendingTransactions(root);
    recoverDirectoryTransaction(active, transactionId, { root, direction: 'rollback' });
    assert.ok(active.load().get('A'));
    assert.equal(new DirectoryTicketStore(archivePath, { archive: true }).load().get('A'), undefined);

    archiveTicket(active, archivePath, 'A', { expectedSnapshotHash: active.load().hash, root, authorized: true });
    assert.throws(() => restoreTicket(active, archivePath, 'A', {
      expectedSnapshotHash: active.load().hash,
      root,
      authorized: true,
      faultInjector: (step) => { if (step === 'operation-applied:2') throw new Error('fault'); },
    }), /fault/);
    [transactionId] = pendingTransactions(root);
    recoverDirectoryTransaction(active, transactionId, { root, direction: 'rollback' });
    assert.equal(active.load().get('A'), undefined);
    assert.ok(new DirectoryTicketStore(archivePath, { archive: true }).load().get('A'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('archive rejects noncanonical and symlinked archive roots before writing a shard', () => {
  const parent = mkdtempSync(join(tmpdir(), 'adlc-ticket-archive-path-'));
  const root = join(parent, 'repo');
  const outside = join(parent, 'outside');
  try {
    const active = new DirectoryTicketStore(writeDirectory(root, [ticket('A')]));
    mkdirSync(outside);
    assert.throws(
      () => archiveTicket(active, outside, 'A', { root, authorized: true }),
      (error) => error.code === 'UNSAFE_ARCHIVE_PATH',
    );
    symlinkSync(outside, join(root, '.adlc/ticket-archive'));
    assert.throws(
      () => archiveTicket(active, join(root, '.adlc/ticket-archive'), 'A', { root, authorized: true }),
      (error) => error.code === 'UNSAFE_STORE_PATH',
    );
    assert.equal(existsSync(join(outside, ticketFilename('A'))), false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
