import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
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
  pendingTransactions,
  prettyCanonicalJson,
  readActiveRailIndex,
  recoverDirectoryTransaction,
  ticketFilename,
  ticketHash,
  writeActiveTicket,
} from '../index.mjs';
import { generateEd25519KeyPair } from '../lib/manifest-crypto.mjs';
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

test('memory-cache serves repeat bound & unbound reads in O(1) while failing closed on corrupt shards and bad pointers', (t) => {
  const root = makeTempDir(t, 'adlc-rail-index-mem-');
  const t1 = ticket('T1', { rails: ['src/auth/**'] });
  const t2 = ticket('T2', { rails: ['src/billing/**'] });
  const t3 = ticket('T3', { rails: ['src/legacy/**'], completed: true });
  const storePath = writeDirectory(root, [t1, t2, t3]);

  // 1. First read does full-load and populates in-process memory-cache
  const viaEnv = readActiveRailIndex(root, { env: { ADLC_TICKET: 'T1' }, key: null });
  assert.equal(viaEnv.ok, true);
  assert.equal(viaEnv.source, 'full-load');
  assert.equal(viaEnv.boundTicket, true);
  assert.equal(viaEnv.activeTicket.id, 'T1');
  assert.deepEqual(viaEnv.rails, ['src/auth/**']);

  // 2. Second read hits in-process memory-cache without re-reading shards
  writeActiveTicket(root, { id: 'T2', ticketHash: ticketHash(t2) });
  const viaPointer = readActiveRailIndex(root, { env: {}, key: null });
  assert.equal(viaPointer.ok, true);
  assert.equal(viaPointer.source, 'memory-cache');
  assert.equal(viaPointer.boundTicket, true);
  assert.equal(viaPointer.activeTicket.id, 'T2');
  assert.deepEqual(viaPointer.rails, ['src/billing/**']);

  // 3. Conflict between ADLC_TICKET and current-ticket.json -> fail closed
  const conflict = readActiveRailIndex(root, { env: { ADLC_TICKET: 'T1' }, key: null });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.source, 'error');
  assert.match(conflict.error, /conflicts/);

  // 4. Stale ticketHash in pointer -> fail closed
  writeActiveTicket(root, { id: 'T2', ticketHash: '0'.repeat(64) });
  const stale = readActiveRailIndex(root, { env: {}, key: null });
  assert.equal(stale.ok, false);
  assert.equal(stale.source, 'error');
  assert.match(stale.error, /changed after selection/);

  // 5. Completed bound ticket -> fail closed
  unlinkSync(join(root, '.adlc/current-ticket.json'));
  const completed = readActiveRailIndex(root, { env: { ADLC_TICKET: 'T3' }, key: null });
  assert.equal(completed.ok, false);
  assert.equal(completed.source, 'error');
  assert.match(completed.error, /already completed/);

  // 6. Missing bound ticket -> fail closed
  const missing = readActiveRailIndex(root, { env: { ADLC_TICKET: 'T999' }, key: null });
  assert.equal(missing.ok, false);
  assert.equal(missing.source, 'error');
  assert.match(missing.error, /not in the ticket store/);

  // 7. Corrupt UNRELATED shard fails closed even when bound to valid T1 (no loadOne bypass!)
  writeFileSync(join(storePath, ticketFilename('T2')), '{corrupt-unrelated-shard');
  const corruptUnrelated = readActiveRailIndex(root, { env: { ADLC_TICKET: 'T1' }, key: null });
  assert.equal(corruptUnrelated.ok, false);
  assert.equal(corruptUnrelated.source, 'error');
});

test('signed on-disk index-cache rejects forged/unsigned entries and verifies HMAC & Ed25519 signatures', (t) => {
  const root = makeTempDir(t, 'adlc-rail-index-signed-');
  const storePath = writeDirectory(root, [
    ticket('T1', { rails: ['src/a/**'] }),
    ticket('T2', { rails: ['src/done/**'], completed: true }),
  ]);
  const hmacKey = 'test-manifest-hmac-key-1430';

  // 1. Unsigned forged on-disk cache with rails: [] MUST be rejected (fail closed to full-load)
  const fp = computeDirectoryStoreFingerprint(storePath);
  assert.ok(fp);
  writeFileSync(join(root, ACTIVE_RAIL_INDEX_FILE), JSON.stringify({
    version: 1,
    sigVersion: 2,
    storeFingerprint: fp,
    activeTickets: [],
    rails: [],
  }));
  const forged = readActiveRailIndex(root, { env: {}, key: null });
  assert.equal(forged.ok, true);
  assert.equal(forged.source, 'full-load');
  assert.deepEqual(forged.rails, ['src/a/**']);

  // 2. Write HMAC-signed cache on a fresh store dir so memoryCache is cold when reading back
  const root2 = makeTempDir(t, 'adlc-rail-index-hmac-');
  const storePath2 = writeDirectory(root2, [ticket('T1', { rails: ['src/sec/**'] })]);
  const populated = readActiveRailIndex(root2, { env: {}, writeCache: true, key: hmacKey });
  assert.equal(populated.ok, true);
  assert.equal(populated.source, 'full-load');
  assert.equal(existsSync(join(root2, ACTIVE_RAIL_INDEX_FILE)), true);
  const rawDoc = JSON.parse(readFileSync(join(root2, ACTIVE_RAIL_INDEX_FILE), 'utf8'));
  assert.equal(rawDoc.sigVersion, 2);
  assert.equal(typeof rawDoc.sig, 'string');

  // Tampering with signed cache rails fails signature check -> falls back to full-load
  const root3 = makeTempDir(t, 'adlc-rail-index-ed25519-');
  const storePath3 = writeDirectory(root3, [ticket('T1', { rails: ['src/ed/**'] })]);
  const { privateKey, publicKey } = generateEd25519KeyPair();
  writeFileSync(join(root3, '.adlc', 'admin.pub'), publicKey);
  const edPop = readActiveRailIndex(root3, { env: {}, writeCache: true, key: privateKey });
  assert.equal(edPop.ok, true);
  assert.equal(edPop.source, 'full-load');

  // Verify Ed25519 signed cache is accepted in a fresh process (cold memoryCache) using only admin.pub!
  const probe = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { readActiveRailIndex } from ${JSON.stringify(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'index.mjs'))};
     console.log(JSON.stringify(readActiveRailIndex(${JSON.stringify(root3)}, { env: {}, key: null })));`,
  ], { encoding: 'utf8', env: { ...process.env, ADLC_MANIFEST_KEY: '', ADLC_MANIFEST_PRIVATE_KEY: '' } });
  assert.equal(probe.status, 0, probe.stderr);
  const coldHit = JSON.parse(probe.stdout);
  assert.equal(coldHit.ok, true);
  assert.equal(coldHit.source, 'index-cache');
  assert.deepEqual(coldHit.rails, ['src/ed/**']);

  // Tamper with rails in root3 cache -> fresh process rejects signature and falls back to full-load
  const tampered = JSON.parse(readFileSync(join(root3, ACTIVE_RAIL_INDEX_FILE), 'utf8'));
  tampered.rails = [];
  writeFileSync(join(root3, ACTIVE_RAIL_INDEX_FILE), JSON.stringify(tampered));
  const tamperProbe = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { readActiveRailIndex } from ${JSON.stringify(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'index.mjs'))};
     console.log(JSON.stringify(readActiveRailIndex(${JSON.stringify(root3)}, { env: {}, key: null })));`,
  ], { encoding: 'utf8', env: { ...process.env, ADLC_MANIFEST_KEY: '', ADLC_MANIFEST_PRIVATE_KEY: '' } });
  assert.equal(tamperProbe.status, 0, tamperProbe.stderr);
  const tamperOut = JSON.parse(tamperProbe.stdout);
  assert.equal(tamperOut.ok, true);
  assert.equal(tamperOut.source, 'full-load');
  assert.deepEqual(tamperOut.rails, ['src/ed/**']);

  // Symlinked cache file -> ignored, falls back to full-load
  const outside = join(root2, 'fake-cache.json');
  writeFileSync(outside, readFileSync(join(root2, ACTIVE_RAIL_INDEX_FILE)));
  unlinkSync(join(root2, ACTIVE_RAIL_INDEX_FILE));
  symlinkSync(outside, join(root2, ACTIVE_RAIL_INDEX_FILE));
  const afterSymlink = readActiveRailIndex(root2, { env: {}, key: hmacKey });
  assert.equal(afterSymlink.ok, true);

  // Read-only .adlc directory with writeCache: true -> tolerates EACCES
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    const rootRo = makeTempDir(t, 'adlc-rail-index-ro-');
    writeDirectory(rootRo, [ticket('T1', { rails: ['src/ro/**'] })]);
    chmodSync(join(rootRo, '.adlc'), 0o555);
    const onRo = readActiveRailIndex(rootRo, { env: {}, writeCache: true, key: hmacKey });
    chmodSync(join(rootRo, '.adlc'), 0o755);
    assert.equal(onRo.ok, true);
    assert.equal(onRo.source, 'full-load');
    assert.deepEqual(onRo.rails, ['src/ro/**']);
  }

  // Unrecognized entry in store -> fingerprint returns null -> fallback store.load() fails closed
  writeFileSync(join(storePath2, 'stray.txt'), 'nope');
  assert.equal(computeDirectoryStoreFingerprint(storePath2), null);
  const failed = readActiveRailIndex(root2, { env: {}, key: hmacKey });
  assert.equal(failed.ok, false);
  assert.equal(failed.source, 'error');
  assert.ok(storePath3);
});

test('archiveCompletedTickets dry-run, inbound-edge skipping, batch write, CLI, and crash recovery', (t) => {
  const root = makeTempDir(t, 'adlc-archive-completed-');
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
  assert.equal(cliDryOut.operation, 'archive');
  assert.equal(cliDryOut.batch, true);
  assert.equal(cliDryOut.dryRun, true);
  assert.deepEqual([...cliDryOut.archivedIds].sort(), ['C_FREE_1', 'C_FREE_2']);
  assert.equal(cliDryOut.remainingCount, 3);

  // 3. write: true without authorized throws AUTHORIZATION_REQUIRED
  assert.throws(
    () => archiveCompletedTickets(store, archivePath, { root, write: true, authorized: false, allowUnsigned: true }),
    (err) => err.code === 'AUTHORIZATION_REQUIRED',
  );

  // 4. Crash recovery: fault mid-batch -> rollback restores both active and archive stores cleanly
  assert.throws(
    () => archiveCompletedTickets(store, archivePath, {
      root,
      write: true,
      authorized: true,
      allowUnsigned: true,
      faultInjector: (step) => { if (step === 'operation-applied:2') throw new Error('injected-batch-fault'); },
    }),
    /injected-batch-fault/,
  );
  const [txnId] = pendingTransactions(root);
  assert.ok(txnId, 'interrupted batch archive must leave a recoverable transaction');
  recoverDirectoryTransaction(store, txnId, { root, direction: 'rollback', allowUnsigned: true });
  assert.equal(pendingTransactions(root).length, 0);
  assert.equal(store.load().tickets.length, 5);
  assert.equal(new DirectoryTicketStore(archivePath, { archive: true }).load().tickets.length, 0);

  // 5. CLI --write --authorize --allow-unsigned --json archives eligible completed tickets atomically
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

  // 6. Re-running with nothing left to archive is a clean no-op
  const noop = archiveCompletedTickets(store, archivePath, { root, write: true, authorized: true, allowUnsigned: true });
  assert.equal(noop.applied, false);
  assert.deepEqual(noop.archivedIds, []);
  assert.equal(noop.remainingCount, 3);
});
