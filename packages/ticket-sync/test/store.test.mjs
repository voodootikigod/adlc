import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock, writeTicketsAtomic, readSidecar, writeSidecar } from '../lib/store.mjs';
import { DirectoryTicketStore, TicketService, initializeTicketStores, loadTicketSnapshot } from '@adlc/tickets';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-store-'));
  mkdirSync(join(dir, '.adlc'));
  return dir;
}
const EMPTY = { version: 1, tickets: {}, pendingCreates: {} };

test('writeTicketsAtomic writes valid JSON that reads back', () => {
  const dir = repo();
  try {
    writeTicketsAtomic(dir, { tickets: [{ id: 'T1', title: 'x' }] });
    const back = loadTicketSnapshot({ root: dir }).mutableTickets();
    assert.equal(back[0].id, 'T1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('directory reconciliation rejects a stale source snapshot instead of overwriting a concurrent edit', () => {
  const dir = repo();
  try {
    initializeTicketStores(dir);
    const store = new DirectoryTicketStore(join(dir, '.adlc/tickets'));
    let service = new TicketService(store, { root: dir });
    service.apply(service.planCreate({ id: 'T1', title: 'initial' }));
    const source = store.load();
    const staleDesired = source.mutableTickets().map((ticket) => ({ ...ticket, title: 'remote' }));

    service = new TicketService(store, { root: dir });
    const current = store.load();
    service.apply(service.planUpdate('T1', { ...current.get('T1'), title: 'concurrent' }, { expect: current.ticketHashes.T1 }));

    assert.throws(
      () => writeTicketsAtomic(dir, { tickets: staleDesired }, { expectedSnapshotHash: source.hash }),
      (error) => error.code === 'STALE_SNAPSHOT',
    );
    assert.equal(store.load().get('T1').title, 'concurrent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lock is mutually exclusive: second acquire fails while held, succeeds after release', () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
    assert.ok(acquireLock(dir, { retries: 0 }));
    assert.ok(!acquireLock(dir, { retries: 1, delayMs: 1 }), 'second acquire must fail while held');
    assert.ok(existsSync(join(dir, '.adlc', 'tickets.lock')));
    releaseLock(dir);
    assert.ok(acquireLock(dir, { retries: 0 }), 'acquire succeeds after release');
    releaseLock(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSidecar: absent → empty rebuildable cache', () => {
  const dir = repo();
  try { assert.deepEqual(readSidecar(dir), EMPTY); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSidecar: corrupt JSON → empty cache (fail safe, not throw)', () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, '.adlc', 'ticket-sync.state.json'), '{ broken json');
    assert.deepEqual(readSidecar(dir), EMPTY);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSidecar: writers fail closed on a corrupt recovery sidecar', () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, '.adlc', 'ticket-sync.state.json'), '{ broken json');
    assert.throws(
      () => readSidecar(dir, { strict: true }),
      (error) => error.code === 'SIDECAR_CORRUPT' && error.kind === 'operational',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSidecar: writers fail closed on structurally invalid recovery handles', () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, '.adlc', 'ticket-sync.state.json'), JSON.stringify({
      version: 1,
      tickets: {},
      pendingCreates: { key: { localId: '', number: '42' } },
    }));
    assert.throws(
      () => readSidecar(dir, { strict: true }),
      (error) => error.code === 'SIDECAR_CORRUPT' && /pendingCreates/.test(error.message),
    );
    assert.deepEqual(readSidecar(dir), EMPTY, 'read-only recovery degrades invalid state to an empty cache');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeSidecar round-trips and fills the empty defaults', () => {
  const dir = repo();
  try {
    writeSidecar(dir, { version: 1, tickets: { 'gh:a/b#1': { nodeId: 'N1', syncedHash: 'h' } }, pendingCreates: {} });
    const back = readSidecar(dir);
    assert.equal(back.tickets['gh:a/b#1'].nodeId, 'N1');
    assert.deepEqual(back.pendingCreates, {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
