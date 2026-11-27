import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE_RAIL_INDEX_FILE,
  DirectoryTicketStore,
  archiveCompletedTickets,
  computeDirectoryStoreFingerprint,
  prettyCanonicalJson,
  readActiveRailIndex,
  ticketFilename,
  ticketHash,
  writeActiveTicket,
} from '../index.mjs';
import { ticket, writeDirectory } from './helpers.mjs';

const BIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'adlc-tickets.mjs');

function makeTempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    try { chmodSync(join(dir, '.adlc'), 0o755); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      ADLC_MANIFEST_KEY: '',
      ADLC_MANIFEST_PRIVATE_KEY: '',
      ADLC_TICKET: '',
    },
  });
}

test('loadOne O(1) bound-ticket fast path resolves env and pointer bindings and fails closed on errors', (t) => {
  const root = makeTempDir(t, 'adlc-rail-index-loadone-');
  const t1 = ticket('T1', { rails: ['src/auth/**'] });
  const t2 = ticket('T2', { rails: ['src/billing/**'] });
  const t3 = ticket('T3', { rails: ['src/legacy/**'], completed: true });
  writeDirectory(root, [t1, t2, t3]);

  // 1. Bound via ADLC_TICKET env -> O(1) loadOne fast path
  const viaEnv = readActiveRailIndex(root, { env: { ADLC_TICKET: 'T1' } });
  assert.equal(viaEnv.ok, true);
  assert.equal(viaEnv.source, 'loadOne');
  assert.equal(viaEnv.boundTicket, true);
  assert.equal(viaEnv.activeTicket.id, 'T1');
  assert.deepEqual(viaEnv.rails, ['src/auth/**']);

  // 2. Bound via .adlc/current-ticket.json with matching ticketHash -> loadOne
  writeActiveTicket(root, { id: 'T2', ticketHash: ticketHash(t2) });
  const viaPointer = readActiveRailIndex(root, { env: {} });
  assert.equal(viaPointer.ok, true);
  assert.equal(viaPointer.source, 'loadOne');
  assert.equal(viaPointer.boundTicket, true);
  assert.equal(viaPointer.activeTicket.id, 'T2');
  assert.deepEqual(viaPointer.rails, ['src/billing/**']);

  // 3. Conflict between ADLC_TICKET and current-ticket.json -> fail closed
  const conflict = readActiveRailIndex(root, { env: { ADLC_TICKET: 'T1' } });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.source, 'error');
  assert.match(conflict.error, /conflicts/);

  // 4. Stale ticketHash in pointer -> fail closed
  writeActiveTicket(root, { id: 'T2', ticketHash: '0'.repeat(64) });
  const stale = readActiveRailIndex(root, { env: {} });
  assert.equal(stale.ok, false);
  assert.equal(stale.source, 'error');
  assert.match(stale.error, /changed after selection/);

  // 5. Remove pointer; test completed ticket via env -> fail closed
  unlinkSync(join(root, '.adlc/current-ticket.json'));
  const completed = readActiveRailIndex(root, { env: { ADLC_TICKET: 'T3' } });
  assert.equal(completed.ok, false);
  assert.equal(completed.source, 'error');
  assert.match(completed.error, /already completed/);

  // 6. Missing ticket via env -> fail closed
  const missing = readActiveRailIndex(root, { env: { ADLC_TICKET: 'T999' } });
  assert.equal(missing.ok, false);
  assert.equal(missing.source, 'error');
  assert.match(missing.error, /not found/);

  // 7. Corrupt pointer file -> fail closed
  writeFileSync(join(root, '.adlc/current-ticket.json'), '{not-valid-json');
  const corrupt = readActiveRailIndex(root, { env: {} });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.source, 'error');
  assert.match(corrupt.error, /invalid active ticket selection/);
});

test('index-cache hits on matching fingerprint, invalidates on shard edits, and tolerates corrupt/symlink/RO cache', (t) => {
  const root = makeTempDir(t, 'adlc-rail-index-cache-');
  const storePath = writeDirectory(root, [
    ticket('T1', { rails: ['src/a/**'] }),
    ticket('T2', { rails: ['src/done/**'], completed: true }),
  ]);

  // First call with writeCache: true performs full-load and populates cache
  const first = readActiveRailIndex(root, { env: {}, writeCache: true });
  assert.equal(first.ok, true);
  assert.equal(first.source, 'full-load');
  assert.equal(first.boundTicket, false);
  assert.deepEqual(first.rails, ['src/a/**']);
  assert.equal(existsSync(join(root, ACTIVE_RAIL_INDEX_FILE)), true);

  // Second call hits index-cache in O(1)
  const second = readActiveRailIndex(root, { env: {}, writeCache: false });
  assert.equal(second.ok, true);
  assert.equal(second.source, 'index-cache');
  assert.equal(second.boundTicket, false);
  assert.deepEqual(second.rails, ['src/a/**']);
  assert.equal(second.tickets.length, 1);
  assert.equal(second.activeTicket.id, 'T1');

  // Adding a new shard changes the store fingerprint -> automatic invalidation
  const t3 = ticket('T3', { rails: ['src/c/**'] });
  writeFileSync(join(storePath, ticketFilename('T3')), prettyCanonicalJson(t3));
  const afterAdd = readActiveRailIndex(root, { env: {}, writeCache: true });
  assert.equal(afterAdd.ok, true);
  assert.equal(afterAdd.source, 'full-load');
  assert.deepEqual(afterAdd.rails.sort(), ['src/a/**', 'src/c/**']);

  // Corrupt cache JSON -> falls back cleanly to full-load
  writeFileSync(join(root, ACTIVE_RAIL_INDEX_FILE), '{{{corrupt');
  const afterCorrupt = readActiveRailIndex(root, { env: {}, writeCache: false });
  assert.equal(afterCorrupt.ok, true);
  assert.equal(afterCorrupt.source, 'full-load');
  assert.deepEqual(afterCorrupt.rails.sort(), ['src/a/**', 'src/c/**']);

  // Symlinked cache file -> ignored, falls back cleanly to full-load
  const outside = join(root, 'fake-cache.json');
  writeFileSync(outside, JSON.stringify({
    version: 1,
    storeFingerprint: computeDirectoryStoreFingerprint(storePath),
    activeTickets: [],
    rails: [],
  }));
  unlinkSync(join(root, ACTIVE_RAIL_INDEX_FILE));
  symlinkSync(outside, join(root, ACTIVE_RAIL_INDEX_FILE));
  const afterSymlink = readActiveRailIndex(root, { env: {}, writeCache: false });
  assert.equal(afterSymlink.ok, true);
  assert.equal(afterSymlink.source, 'full-load');
  assert.deepEqual(afterSymlink.rails.sort(), ['src/a/**', 'src/c/**']);

  // Read-only .adlc directory with writeCache: true -> tolerates EACCES
  unlinkSync(join(root, ACTIVE_RAIL_INDEX_FILE));
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    chmodSync(join(root, '.adlc'), 0o555);
    const onRo = readActiveRailIndex(root, { env: {}, writeCache: true });
    chmodSync(join(root, '.adlc'), 0o755);
    assert.equal(onRo.ok, true);
    assert.equal(onRo.source, 'full-load');
    assert.deepEqual(onRo.rails.sort(), ['src/a/**', 'src/c/**']);
  }

  // Unrecognized entry in store -> fingerprint returns null -> fallback store.load() fails closed
  writeFileSync(join(storePath, 'stray.txt'), 'nope');
  assert.equal(computeDirectoryStoreFingerprint(storePath), null);
  const failed = readActiveRailIndex(root, { env: {} });
  assert.equal(failed.ok, false);
  assert.equal(failed.source, 'error');
});

test('archiveCompletedTickets dry-run, inbound-edge skipping, batch write, and CLI integration', (t) => {
  const root = makeTempDir(t, 'adlc-archive-completed-');
  // Graph:
  // - U1 (uncompleted) -> C_DIRECT (completed) -> C_TRANSITIVE (completed)
  // - C_FREE_1 (completed, no inbound active edge)
  // - C_FREE_2 (completed, references C_FREE_1 — both completed, both archivable!)
  const storePath = writeDirectory(root, [
    ticket('U1', { rails: ['src/live/**'], edges: [{ to: 'C_DIRECT' }] }),
    ticket('C_DIRECT', { completed: true, edges: [{ to: 'C_TRANSITIVE' }] }),
    ticket('C_TRANSITIVE', { completed: true }),
    ticket('C_FREE_1', { completed: true }),
    ticket('C_FREE_2', { completed: true, edges: [{ to: 'C_FREE_1' }] }),
  ]);
  const store = new DirectoryTicketStore(storePath);
  const archivePath = join(root, '.adlc/ticket-archive');

  // 1. Dry-run needs no --authorize and no signing key, and leaves store intact
  const dry = archiveCompletedTickets(store, archivePath, { root, write: false });
  assert.equal(dry.dryRun, true);
  assert.deepEqual([...dry.archivedIds].sort(), ['C_FREE_1', 'C_FREE_2']);
  assert.deepEqual(dry.skippedIds.map((s) => s.id).sort(), ['C_DIRECT', 'C_TRANSITIVE']);
  assert.ok(dry.skippedIds.every((s) => s.reason === 'inbound-active-edge'));
  assert.equal(dry.remainingCount, 3);
  assert.equal(dry.expectedSnapshotHash, store.load().hash);
  assert.equal(existsSync(archivePath), false);

  // 2. CLI dry-run via `adlc-tickets archive-completed --json`
  const cliDry = runCli(['archive-completed', '--root', root, '--json'], root);
  assert.equal(cliDry.status, 0, cliDry.stderr);
  const cliDryOut = JSON.parse(cliDry.stdout);
  assert.equal(cliDryOut.operation, 'archive-batch');
  assert.equal(cliDryOut.dryRun, true);
  assert.deepEqual([...cliDryOut.archivedIds].sort(), ['C_FREE_1', 'C_FREE_2']);
  assert.equal(cliDryOut.remainingCount, 3);

  // 3. write: true without authorized throws AUTHORIZATION_REQUIRED
  assert.throws(
    () => archiveCompletedTickets(store, archivePath, { root, write: true, authorized: false, allowUnsigned: true }),
    (err) => err.code === 'AUTHORIZATION_REQUIRED',
  );

  // 4. CLI --write --authorize --allow-unsigned --json archives eligible completed tickets atomically
  const cliWrite = runCli(['archive-completed', '--root', root, '--write', '--authorize', '--allow-unsigned', '--json'], root);
  assert.equal(cliWrite.status, 0, cliWrite.stderr);
  const cliWriteOut = JSON.parse(cliWrite.stdout);
  assert.equal(cliWriteOut.dryRun, false);
  assert.equal(cliWriteOut.applied, true);
  assert.deepEqual([...cliWriteOut.archivedIds].sort(), ['C_FREE_1', 'C_FREE_2']);
  assert.equal(cliWriteOut.remainingCount, 3);

  // Verify active store and archive store contents
  const afterActive = store.load();
  assert.deepEqual(afterActive.tickets.map((item) => item.id).sort(), ['C_DIRECT', 'C_TRANSITIVE', 'U1']);
  const archivedSnap = new DirectoryTicketStore(archivePath, { archive: true }).load();
  assert.deepEqual(archivedSnap.tickets.map((item) => item.id).sort(), ['C_FREE_1', 'C_FREE_2']);

  // 5. Re-running with nothing left to archive is a clean no-op
  const noop = archiveCompletedTickets(store, archivePath, { root, write: true, authorized: true, allowUnsigned: true });
  assert.equal(noop.applied, false);
  assert.deepEqual(noop.archivedIds, []);
  assert.equal(noop.remainingCount, 3);

  // 6. Oversized .active-rail-index.json (> 1 MiB) fails closed to full-load
  const oversized = JSON.stringify({
    version: 1,
    storeFingerprint: computeDirectoryStoreFingerprint(store.path),
    activeTickets: [],
    rails: [],
    pad: 'x'.repeat(1024 * 1024 + 64),
  });
  writeFileSync(join(root, ACTIVE_RAIL_INDEX_FILE), oversized);
  const afterOversized = readActiveRailIndex(root, { env: { ADLC_TICKET: '' }, writeCache: false });
  assert.equal(afterOversized.ok, true);
  assert.equal(afterOversized.source, 'full-load');

  // 7. CLI `restore` exercises mutationCommands set membership for 'restore'
  const cliRestore = runCli(['restore', 'C_FREE_1', '--root', root, '--write', '--authorize', '--allow-unsigned', '--json'], root);
  assert.equal(cliRestore.status, 0, cliRestore.stderr);
  assert.equal(store.load().get('C_FREE_1').id, 'C_FREE_1');
});
