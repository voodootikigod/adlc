import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectTicketStore, exportLegacyStore, migrateLegacyStore } from '../index.mjs';
import { writeLegacy } from './helpers.mjs';

const realStore = JSON.parse(readFileSync(new URL('../../../.adlc/tickets.json', import.meta.url), 'utf8'));

test('the real repository store migrates and exports with exact logical hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-migrate-'));
  try {
    writeLegacy(root, realStore.tickets);
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
