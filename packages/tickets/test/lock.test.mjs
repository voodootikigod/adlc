import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
