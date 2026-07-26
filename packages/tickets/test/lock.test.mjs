import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTicketLock, readTicketLock, releaseTicketLock } from '../index.mjs';

test('one worktree lock records ownership and serializes writers without stealing stale locks', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-lock-'));
  try {
    const first = acquireTicketLock(root, { retries: 0, transactionId: 'one', command: 'test' });
    const metadata = readTicketLock(root);
    assert.equal(metadata.pid, process.pid);
    assert.equal(metadata.transactionId, 'one');
    assert.throws(() => acquireTicketLock(root, { retries: 0 }), (error) => error.code === 'LOCK_TIMEOUT');
    assert.deepEqual(readTicketLock(root), metadata, 'a contender must not remove or rewrite the owner');
    releaseTicketLock(first);
    const second = acquireTicketLock(root, { retries: 0 });
    releaseTicketLock(second);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readTicketLock validates the shape it is declared to return', () => {
  // index.d.ts publishes TicketLockMetadata with a numeric pid and version, but
  // this only JSON-parsed whatever was on disk. `owner.json` holding the valid
  // JSON string "stale" therefore satisfied the compiler and crashed the caller
  // on `.pid` — and in an untrusted workspace that file is attacker-controlled.
  // An unrecognized shape now reads as NO lock rather than a lying object.
  const root = mkdtempSync(join(tmpdir(), 'adlc-lock-shape-'));
  try {
    mkdirSync(join(root, '.adlc', 'tickets.lock'), { recursive: true });
    const ownerPath = join(root, '.adlc', 'tickets.lock', 'owner.json');
    const valid = {
      version: 1, pid: 1234, hostname: 'host', startedAt: '2026-07-26T00:00:00.000Z',
      command: 'adlc ticket update', transactionId: null,
    };

    writeFileSync(ownerPath, JSON.stringify(valid));
    assert.deepEqual(readTicketLock(root), valid, 'a well-formed lock still reads back');

    for (const [label, body] of [
      ['a bare string', '"stale"'],
      ['a number', '7'],
      ['null', 'null'],
      ['an array', '[]'],
      ['an empty object', '{}'],
      ['a missing pid', JSON.stringify({ ...valid, pid: undefined })],
      ['a string pid', JSON.stringify({ ...valid, pid: '1234' })],
      ['an unknown version', JSON.stringify({ ...valid, version: 2 })],
      ['a non-string command', JSON.stringify({ ...valid, command: 5 })],
      ['a numeric transactionId', JSON.stringify({ ...valid, transactionId: 5 })],
    ]) {
      writeFileSync(ownerPath, body);
      assert.equal(readTicketLock(root), null, `${label} must read as no lock`);
    }

    // A real transaction id is a string, and that must still be accepted.
    writeFileSync(ownerPath, JSON.stringify({ ...valid, transactionId: 'tx-1' }));
    assert.equal(readTicketLock(root)?.transactionId, 'tx-1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
