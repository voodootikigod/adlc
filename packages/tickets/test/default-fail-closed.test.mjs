// default-fail-closed.test.mjs — the OMITTED-option behavior of privileged entrypoints.
//
// Every option pinned here defaults CLOSED: archiving/restoring without explicit
// authorization refuses; a migration without --write is a plan, not a mutation; a
// transaction without evidenceRequired appends nothing to the manifest; doctor
// without archive:true does not reach into the archive. Callers in this repo pass
// these options explicitly, so nothing else notices if a default silently flips —
// which is exactly the mutation (bool-flip on the default) this file exists to kill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DirectoryTicketStore, archiveTicket, restoreTicket, doctorTicketStore,
} from '../index.mjs';
import { applyDirectoryTransaction } from '../lib/transaction.mjs';
import { migrateLegacyStore } from '../lib/migrate.mjs';
import { ticket, writeDirectory } from './helpers.mjs';

const T = (id) => ticket(id);

function directoryStore(root, tickets) {
  return new DirectoryTicketStore(writeDirectory(root, tickets));
}

test('archiveTicket/restoreTicket REFUSE when authorized is omitted', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-defaults-'));
  try {
    const store = directoryStore(root, [T('A')]);
    const snapshot = store.load();
    assert.throws(
      () => archiveTicket(store, join(root, '.adlc/ticket-archive'), 'A', { expectedSnapshotHash: snapshot.hash, root, key: null }),
      /AUTHORIZATION_REQUIRED|authorization/i,
    );
    assert.throws(
      () => restoreTicket(store, join(root, '.adlc/ticket-archive'), 'A', { expectedSnapshotHash: snapshot.hash, root, key: null }),
      /AUTHORIZATION_REQUIRED|authorization/i,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applyDirectoryTransaction appends NO manifest evidence when evidenceRequired is omitted', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-defaults-'));
  try {
    const store = directoryStore(root, [T('A')]);
    // Apply a REAL transaction with evidenceRequired omitted.
    applyDirectoryTransaction(store, [T('A'), T('B')], { root, expectedSnapshotHash: store.load().hash, operation: 'update' });
    assert.equal(existsSync(join(root, '.adlc', 'manifest.jsonl')), false,
      'an ordinary transaction must not write evidence unless asked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migrateLegacyStore is a DRY-RUN plan when write is omitted', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-defaults-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [T('A')] }));
    const plan = migrateLegacyStore(root, { key: null });
    assert.notEqual(plan.applied, true, 'omitting write must never apply');
    assert.equal(existsSync(join(root, '.adlc', 'tickets')), false, 'no directory store materializes on a dry run');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctorTicketStore does NOT inspect the archive when archive is omitted', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-defaults-'));
  try {
    const store = directoryStore(root, [T('A')]);
    // Plant a MALFORMED archive: if doctor reached into it by default, it would flag it.
    mkdirSync(join(root, '.adlc', 'ticket-archive'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'ticket-archive', 'broken.json'), '{not json');
    const report = doctorTicketStore(store, { root, key: null });
    assert.equal(report.checks.some((c) => c.name === 'archive'), false,
      'no archive check may run unless archive: true is passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
