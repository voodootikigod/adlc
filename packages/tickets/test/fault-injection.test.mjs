import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DirectoryTicketStore, LegacyTicketStore, applyDirectoryTransaction, applyLegacyTransaction, detectTicketStore, pendingTransactions, recoverDirectoryTransaction } from '../index.mjs';
import { ticket, writeDirectory, writeLegacy } from './helpers.mjs';

for (const faultAt of ['journal-prepared', 'operation-applied:1', 'operation-applied:2', 'before-final-verify']) {
  test(`fault at ${faultAt} leaves a detectable journal and supports idempotent completion`, () => {
    const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-fault-'));
    try {
      const path = writeDirectory(root, [ticket('A'), ticket('B')]);
      const store = new DirectoryTicketStore(path);
      const before = store.load();
      const desired = [ticket('A', { title: 'Changed A' }), ticket('C')];
      assert.throws(() => applyDirectoryTransaction(store, desired, {
        root,
        expectedSnapshotHash: before.hash,
        faultInjector: (step) => { if (step === faultAt) throw new Error(`fault:${step}`); },
      }), new RegExp(`fault:${faultAt.replace(':', '\\:')}`));
      const pending = pendingTransactions(root);
      assert.equal(pending.length, 1);
      assert.throws(() => detectTicketStore({ root }), (error) => error.code === 'RECOVERY_REQUIRED');
      const completed = recoverDirectoryTransaction(store, pending[0], { root, direction: 'complete' });
      assert.deepEqual(completed.tickets.map((item) => item.id), ['A', 'C']);
      assert.equal(completed.get('A').title, 'Changed A');
      assert.deepEqual(pendingTransactions(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('rollback restores the exact before snapshot after a partial transaction', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-rollback-'));
  try {
    const path = writeDirectory(root, [ticket('A'), ticket('B')]);
    const store = new DirectoryTicketStore(path);
    const before = store.load();
    assert.throws(() => applyDirectoryTransaction(store, [ticket('A', { title: 'changed' }), ticket('C')], {
      root,
      expectedSnapshotHash: before.hash,
      faultInjector: (step) => { if (step === 'operation-applied:2') throw new Error('crash'); },
    }));
    const [id] = pendingTransactions(root);
    const rolledBack = recoverDirectoryTransaction(store, id, { root, direction: 'rollback' });
    assert.equal(rolledBack.hash, before.hash);
    assert.deepEqual(rolledBack.mutableTickets(), before.mutableTickets());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recovery rejects journal paths that escape the repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-hostile-journal-'));
  const escaped = join(root, '..', `adlc-escaped-${process.pid}`);
  try {
    const store = new DirectoryTicketStore(writeDirectory(root, [ticket('A')]));
    assert.throws(() => applyDirectoryTransaction(store, [ticket('A', { title: 'changed' })], {
      root,
      expectedSnapshotHash: store.load().hash,
      faultInjector: (step) => { if (step === 'journal-prepared') throw new Error('fault'); },
    }));
    const [id] = pendingTransactions(root);
    const path = join(root, '.adlc/ticket-transactions', id, 'journal.json');
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    journal.operations[0].target = `../${basename(escaped)}`;
    writeFileSync(path, JSON.stringify(journal));
    assert.throws(() => recoverDirectoryTransaction(store, id, { root, direction: 'complete' }), (error) => error.code === 'UNSAFE_JOURNAL_PATH');
    assert.equal(existsSync(escaped), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(escaped, { recursive: true, force: true });
  }
});

test('recovery rejects a journal target redirected to an unrelated repository file', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-hostile-target-'));
  try {
    const store = new DirectoryTicketStore(writeDirectory(root, [ticket('A')]));
    const victim = join(root, '.adlc', 'config.json');
    writeFileSync(victim, '{"preserve":true}\n');
    assert.throws(() => applyDirectoryTransaction(store, [ticket('A', { title: 'changed' })], {
      root,
      expectedSnapshotHash: store.load().hash,
      faultInjector: (step) => { if (step === 'journal-prepared') throw new Error('fault'); },
    }));
    const [id] = pendingTransactions(root);
    const path = join(root, '.adlc/ticket-transactions', id, 'journal.json');
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    journal.operations[0].target = '.adlc/config.json';
    writeFileSync(path, JSON.stringify(journal));
    assert.throws(() => recoverDirectoryTransaction(store, id, { root, direction: 'complete' }), (error) => error.code === 'INVALID_JOURNAL');
    assert.equal(readFileSync(victim, 'utf8'), '{"preserve":true}\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recovery rejects a journal stage redirected to an unrelated repository file', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-hostile-stage-'));
  try {
    const store = new DirectoryTicketStore(writeDirectory(root, [ticket('A')]));
    const source = join(root, '.adlc', 'config.json');
    writeFileSync(source, '{"inject":true}\n');
    assert.throws(() => applyDirectoryTransaction(store, [ticket('A', { title: 'changed' })], {
      root,
      expectedSnapshotHash: store.load().hash,
      faultInjector: (step) => { if (step === 'journal-prepared') throw new Error('fault'); },
    }));
    const [id] = pendingTransactions(root);
    const path = join(root, '.adlc/ticket-transactions', id, 'journal.json');
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    journal.operations[0].stage = '.adlc/config.json';
    writeFileSync(path, JSON.stringify(journal));
    assert.throws(() => recoverDirectoryTransaction(store, id, { root, direction: 'complete' }), (error) => error.code === 'INVALID_JOURNAL');
    assert.equal(store.load().get('A').title, 'Ticket A');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recovery does not let a forged transactionKey legitimize a redirected stage', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-hostile-key-'));
  try {
    const store = new DirectoryTicketStore(writeDirectory(root, [ticket('A')]));
    writeFileSync(join(root, '.adlc', 'config.json'), '{"inject":true}\n');
    assert.throws(() => applyDirectoryTransaction(store, [ticket('A', { title: 'changed' })], {
      root,
      expectedSnapshotHash: store.load().hash,
      faultInjector: (step) => { if (step === 'journal-prepared') throw new Error('fault'); },
    }));
    const [id] = pendingTransactions(root);
    const path = join(root, '.adlc/ticket-transactions', id, 'journal.json');
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    journal.operations[0].transactionKey = '../../../config.json';
    journal.operations[0].stage = '.adlc/config.json';
    writeFileSync(path, JSON.stringify(journal));
    assert.throws(() => recoverDirectoryTransaction(store, id, { root, direction: 'complete' }), (error) => error.code === 'INVALID_JOURNAL');
    assert.equal(store.load().get('A').title, 'Ticket A');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('interrupted legacy evidence transaction is detectable and rolls back exactly', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-legacy-fault-'));
  try {
    writeLegacy(root, [ticket('A')]);
    const store = new LegacyTicketStore(join(root, '.adlc/tickets.json'));
    const before = store.load();
    assert.throws(() => applyLegacyTransaction(store, [ticket('A', { completed: true })], {
      root,
      expectedSnapshotHash: before.hash,
      operation: 'complete',
      evidenceRequired: true,
      ticketId: 'A',
      faultInjector: (step) => { if (step === 'operation-applied:1') throw new Error('crash'); },
    }), /crash/);
    const [transactionId] = pendingTransactions(root);
    assert.ok(transactionId);
    assert.throws(() => detectTicketStore({ root }), (error) => error.code === 'RECOVERY_REQUIRED');
    const restored = recoverDirectoryTransaction(store, transactionId, { root, direction: 'rollback' });
    assert.equal(restored.hash, before.hash);
    assert.equal(restored.get('A').completed, undefined);
    assert.deepEqual(pendingTransactions(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reassignment rollback evidence binds the restored identity and a non-null hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-reassign-rollback-'));
  try {
    writeLegacy(root, [ticket('OLD')]);
    const store = new LegacyTicketStore(join(root, '.adlc/tickets.json'));
    const before = store.load();
    assert.throws(() => applyLegacyTransaction(store, [ticket('NEW')], {
      root,
      expectedSnapshotHash: before.hash,
      operation: 'reassign',
      evidenceRequired: true,
      ticketId: 'NEW',
      beforeTicketId: 'OLD',
      faultInjector: (step) => { if (step === 'operation-applied:1') throw new Error('crash'); },
    }), /crash/);
    const [transactionId] = pendingTransactions(root);
    recoverDirectoryTransaction(store, transactionId, { root, direction: 'rollback' });
    const evidence = JSON.parse(readFileSync(join(root, '.adlc/manifest.jsonl'), 'utf8').trim());
    assert.equal(evidence.ticket, 'OLD');
    assert.equal(evidence.data.ticketHash, store.load().ticketHashes.OLD);
    assert.equal(evidence.data.bindingScope, 'ticket');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recovery permits only the configured external directory store subtree', () => {
  const parent = mkdtempSync(join(tmpdir(), 'adlc-ticket-external-directory-'));
  const root = join(parent, 'repo');
  try {
    writeDirectory(root, []);
    const externalPath = writeDirectory(parent, [ticket('A')]);
    const store = new DirectoryTicketStore(externalPath);
    const before = store.load();
    assert.throws(() => applyDirectoryTransaction(store, [ticket('A', { title: 'changed' })], {
      root,
      expectedSnapshotHash: before.hash,
      faultInjector: (step) => { if (step === 'operation-applied:1') throw new Error('crash'); },
    }), /crash/);
    const [transactionId] = pendingTransactions(root);
    const restored = recoverDirectoryTransaction(store, transactionId, { root, direction: 'rollback' });
    assert.equal(restored.hash, before.hash);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('recovery rejects external store metadata as a redirected shard target', () => {
  const parent = mkdtempSync(join(tmpdir(), 'adlc-ticket-external-hostile-'));
  const root = join(parent, 'repo');
  try {
    writeDirectory(root, []);
    const externalPath = writeDirectory(parent, [ticket('A')]);
    const store = new DirectoryTicketStore(externalPath);
    assert.throws(() => applyDirectoryTransaction(store, [ticket('A', { title: 'changed' })], {
      root,
      expectedSnapshotHash: store.load().hash,
      faultInjector: (step) => { if (step === 'journal-prepared') throw new Error('fault'); },
    }));
    const [transactionId] = pendingTransactions(root);
    const path = join(root, '.adlc/ticket-transactions', transactionId, 'journal.json');
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    journal.operations[0].target = join(externalPath, '.store.json');
    writeFileSync(path, JSON.stringify(journal));
    assert.throws(
      () => recoverDirectoryTransaction(store, transactionId, { root, direction: 'complete' }),
      (error) => error.code === 'INVALID_JOURNAL',
    );
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
