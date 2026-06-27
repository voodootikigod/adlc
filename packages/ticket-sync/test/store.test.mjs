import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock, writeTicketsAtomic, readSidecar, writeSidecar } from '../lib/store.mjs';

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
    const back = JSON.parse(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'));
    assert.equal(back.tickets[0].id, 'T1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lock is mutually exclusive: second acquire fails while held, succeeds after release', () => {
  const dir = repo();
  try {
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

test('writeSidecar round-trips and fills the empty defaults', () => {
  const dir = repo();
  try {
    writeSidecar(dir, { version: 1, tickets: { 'gh:a/b#1': { nodeId: 'N1', syncedHash: 'h' } }, pendingCreates: {} });
    const back = readSidecar(dir);
    assert.equal(back.tickets['gh:a/b#1'].nodeId, 'N1');
    assert.deepEqual(back.pendingCreates, {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
