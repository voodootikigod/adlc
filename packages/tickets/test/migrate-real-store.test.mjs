import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { detectTicketStore, exportLegacyStore, migrateLegacyStore } from '../index.mjs';
import { writeLegacy } from './helpers.mjs';

// The repository's own ticket corpus, read through the store abstraction rather
// than a fixed path: this repo has itself migrated from the legacy
// `.adlc/tickets.json` to the sharded `.adlc/tickets/` backend, and the point of
// this test is to exercise migration against real tickets whichever backend
// currently holds them.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const realTickets = detectTicketStore({ root: repoRoot }).load().mutableTickets();

test('the real repository store migrates and exports with exact logical hashes', () => {
  // Guard against a vacuous pass: reading through the store abstraction cannot
  // throw the way the old fixed-path read did, so an empty/unresolved store
  // would otherwise migrate zero tickets and assert nothing meaningful.
  assert.ok(realTickets.length > 0, 'expected the repository store to hold tickets');
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-migrate-'));
  try {
    writeLegacy(root, realTickets);
    const before = detectTicketStore({ root }).load();
    const plan = migrateLegacyStore(root);
    assert.equal(plan.beforeHash, before.hash);
    assert.equal(detectTicketStore({ root }).backend, undefined);
    migrateLegacyStore(root, { write: true, yes: true, requireClean: false });
    const after = detectTicketStore({ root }).load();
    assert.equal(after.hash, before.hash);
    const exported = exportLegacyStore(detectTicketStore({ root }), join(root, 'export.json'));
    assert.equal(exported.hash, before.hash);
    assert.deepEqual(exported.mutableTickets(), before.mutableTickets());
  } finally { rmSync(root, { recursive: true, force: true }); }
});
