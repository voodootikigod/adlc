import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTicketStore } from '../index.mjs';
import { writeDirectory } from './helpers.mjs';

test('runtime state remains outside tracked stores and planted runtime files invalidate layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-runtime-'));
  try {
    const path = writeDirectory(root, []);
    for (const runtime of ['tickets.lock', 'ticket-transactions', 'current-ticket.json', 'ticket-sync.state.json']) {
      assert.equal(join(root, '.adlc', runtime).startsWith(`${path}/`), false);
    }
    writeFileSync(join(path, 'current-ticket.json'), '{}');
    assert.throws(() => new DirectoryTicketStore(path).load(), (error) => ['UNRECOGNIZED_STORE_ENTRY', 'INVALID_SHARD'].includes(error.code));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
