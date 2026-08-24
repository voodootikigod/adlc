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
//
// `env: {}` is required for that claim to hold. detectTicketStore defaults to
// `env = process.env` and honours ADLC_TICKET_STORE / ADLC_TICKETS, so a runner
// that exports either variable for an unrelated ADLC operation would silently
// redirect this test to that store — every hash assertion would still pass while
// the actual repository corpus went unexercised, and the non-empty guard below
// would not notice because an override store is also non-empty.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const loadRepoCorpus = () => detectTicketStore({ root: repoRoot, env: {} }).load().mutableTickets();
const realTickets = loadRepoCorpus();

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
    // The real repository store declares rails, so it is a frozen trust root and a
    // migration — which rewrites the whole store — is an audited override that must
    // be signable (packages/tickets/test/bypass-audit.test.mjs). Incidental to the
    // hash equivalences this test is about.
    migrateLegacyStore(root, { write: true, yes: true, requireClean: false, key: 'test-manifest-key' });
    const after = detectTicketStore({ root }).load();
    assert.equal(after.hash, before.hash);
    const exported = exportLegacyStore(detectTicketStore({ root }), join(root, 'export.json'));
    assert.equal(exported.hash, before.hash);
    assert.deepEqual(exported.mutableTickets(), before.mutableTickets());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the real-corpus loader cannot be redirected by store-override environment variables', () => {
  // Pins the property the comment above depends on. `.adlc/tickets.example.json`
  // is a VALID, non-empty store, so without `env: {}` the override silently wins
  // and this test's corpus is no longer the repository's.
  for (const varName of ['ADLC_TICKET_STORE', 'ADLC_TICKETS']) {
    const previous = process.env[varName];
    process.env[varName] = '.adlc/tickets.example.json';
    try {
      assert.deepEqual(loadRepoCorpus(), realTickets, `${varName} must not redirect the real-corpus loader`);
    } finally {
      if (previous === undefined) delete process.env[varName];
      else process.env[varName] = previous;
    }
  }
});
