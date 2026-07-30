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
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('migrateLegacyStore with write but WITHOUT yes refuses; requireClean defaults ON (dirty tree refuses)', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-defaults-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [T('A')] }));
    // write:true without yes → confirmation required, nothing applied.
    assert.throws(() => migrateLegacyStore(root, { write: true, key: null }), /CONFIRMATION_REQUIRED|--yes/);
    // write+yes on a DIRTY tree (tickets.json is untracked) → requireClean default refuses.
    assert.throws(() => migrateLegacyStore(root, { write: true, yes: true, key: null }), /DIRTY_WORKTREE|clean worktree/);
    assert.equal(existsSync(join(root, '.adlc', 'tickets')), false, 'no store materialized by either refusal');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('store recover routes by journal.operation: an interrupted MIGRATE journal recovers via migrate recovery', () => {
  // Pins bin/adlc-tickets.mjs's `journal.operation === 'migrate'` comparison. A REAL
  // interrupted migration leaves a prepared migrate journal; `store recover --complete`
  // must route it to recoverMigration, which completes the migration (directory store
  // materializes, exit 0). Inverted, the bin hands it to directory recovery, which
  // cannot complete a migrate journal — a loud non-zero failure.
  const root = mkdtempSync(join(tmpdir(), 'adlc-defaults-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), `${JSON.stringify({ tickets: [T('A')] }, null, 2)}\n`);
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    assert.throws(() => migrateLegacyStore(root, {
      write: true, yes: true, requireClean: false, key: null,
      faultInjector(name) { if (name === 'directory-renamed') throw new Error('fault:directory-renamed'); },
    }), /fault:directory-renamed/);
    const bin = fileURLToPath(new URL('../bin/adlc-tickets.mjs', import.meta.url));
    let status = 0, out = '';
    try {
      out = execFileSync(process.execPath, [bin, 'store', 'recover', '--complete', '--json'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ADLC_MANIFEST_KEY: '' },
      });
    } catch (err) { status = err.status; out = `${err.stdout}\n${err.stderr}`; }
    assert.equal(status, 0, `migrate journal must complete via migrate recovery, got:\n${out}`);
    assert.equal(existsSync(join(root, '.adlc', 'tickets', '.store.json')), true,
      'completion materializes the directory store — proof the migrate path ran');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an INVALID key is rejected BEFORE any mutation — store bytes, journal, and manifest untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-defaults-'));
  try {
    const store = directoryStore(root, [T('A')]);
    const beforeHash = store.load().hash;
    assert.throws(
      () => applyDirectoryTransaction(store, [T('A'), T('B')], {
        root, expectedSnapshotHash: beforeHash, operation: 'update', evidenceRequired: true, key: '',
      }),
      /key/i,
    );
    assert.equal(store.load().hash, beforeHash, 'store bytes unchanged after the refusal');
    assert.equal(existsSync(join(root, '.adlc', 'manifest.jsonl')), false, 'no evidence written');
    assert.equal(existsSync(join(root, '.adlc', 'transactions')), false, 'no journal persisted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
