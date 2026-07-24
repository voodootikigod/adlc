// The ticket-store loader must be BOUNDED and NON-BLOCKING against a hostile
// store path (issue #341): the store reader is generated into every harness hook
// and its root/override can be attacker-influenced. A FIFO must not block it, a
// giant file/shard must not be slurped, and an over-large directory must FAIL
// CLOSED (throw) — never silently truncate, which would drop tickets (and their
// rails) and open an enforcement hole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadTicketStoreReadOnly,
  readStoreFileBounded,
  readdirEntriesBounded,
  addBounded,
  ticketFilename,
} from '../ticket-readers/read-only-loader.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'adlc-store-dos-'));
}

/** A minimal valid directory store: `.store.json` manifest + one well-formed shard. */
function directoryStore(root, ticket = { id: 'T1', title: 'Fixture' }) {
  const dir = join(root, '.adlc', 'tickets');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
  writeFileSync(join(dir, ticketFilename(ticket.id)), JSON.stringify(ticket));
  return dir;
}

// ---- readStoreFileBounded (file read) ----

test('readStoreFileBounded refuses a non-regular file (a directory) instead of reading it', () => {
  const root = tmp();
  mkdirSync(join(root, 'adir'));
  assert.throws(() => readStoreFileBounded(join(root, 'adir')), /not a regular file/);
});

test('readStoreFileBounded refuses a file over the byte cap (never slurps it)', () => {
  const root = tmp();
  const p = join(root, 'big.json');
  writeFileSync(p, 'x'.repeat(100));
  assert.throws(() => readStoreFileBounded(p, 10), /exceeds the 10-byte read cap/);
  // ...but a file within the cap reads back verbatim.
  assert.equal(readStoreFileBounded(p, 1000), 'x'.repeat(100));
});

test('readStoreFileBounded does not block on a FIFO (POSIX)', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  const p = join(root, 'fifo');
  execFileSync('mkfifo', [p]);
  assert.throws(() => readStoreFileBounded(p), /not a regular file/); // returns, never hangs
});

test('readStoreFileBounded accumulates POSIX short reads — never truncates a large file', () => {
  const root = tmp();
  const p = join(root, 'big.json');
  const content = 'x'.repeat(5000);
  writeFileSync(p, content);
  // Simulate an rsize-capped filesystem: every read returns at most 3 bytes. A
  // single-read implementation would return 3 bytes and truncate; the loop must
  // accumulate the whole file.
  const shortRead = (fd, buf, off, len, pos) => readSync(fd, buf, off, Math.min(len, 3), pos);
  assert.equal(readStoreFileBounded(p, 1 << 20, shortRead), content);
});

// ---- readdirEntriesBounded (directory read) ----

test('readdirEntriesBounded fails CLOSED past the entry cap (does not truncate the store)', () => {
  const root = tmp();
  const dir = join(root, 'many');
  mkdirSync(dir);
  for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, `f${i}.json`), '{}');
  // A cap below the entry count must THROW, not return the first N — a truncated
  // ticket store is a dropped rail.
  assert.throws(() => readdirEntriesBounded(dir, 3), /exceeds 3 entries/);
  // At/above the count, it returns every entry.
  assert.equal(readdirEntriesBounded(dir, 10).length, 5);
});

// ---- addBounded (aggregate byte cap) ----

test('addBounded fails CLOSED once the running total exceeds the aggregate cap', () => {
  // Individually-fine additions that SUM past the cap must throw — this is what
  // stops many under-per-file-cap shards from adding up to an OOM.
  let total = 0;
  total = addBounded(total, 4, 10); // 4
  total = addBounded(total, 4, 10); // 8
  assert.equal(total, 8);
  assert.throws(() => addBounded(total, 4, 10), /aggregate cap/); // 12 > 10
});

// ---- integration: loadTicketStoreReadOnly over a hostile store ----

test('loadTicketStoreReadOnly does not block when .store.json is a FIFO (POSIX)', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  const dir = join(root, '.adlc', 'tickets');
  mkdirSync(dir, { recursive: true });
  execFileSync('mkfifo', [join(dir, '.store.json')]); // the manifest read had NO stat guard
  assert.throws(() => loadTicketStoreReadOnly({ root, env: {} })); // must throw, not hang
});

test('loadTicketStoreReadOnly still loads a well-formed directory store (no happy-path regression)', () => {
  const root = tmp();
  directoryStore(root, { id: 'T1', title: 'Fixture' });
  const snap = loadTicketStoreReadOnly({ root, env: {} });
  assert.equal(snap.tickets.length, 1);
  assert.equal(snap.tickets[0].id, 'T1');
});
