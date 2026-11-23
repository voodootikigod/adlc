import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { gitRepo, tmp } from '@adlc/core/test-kit';
import { ACTIVE_MANIFEST, LOCK_DIRECTORY } from '../lib/constants.mjs';
import { durableWrite, writeFileAtomic } from '../lib/durability.mjs';
import { ticketFilename } from '../lib/filename.mjs';
import { acquireTicketLock, releaseTicketLock } from '../lib/lock.mjs';
import { TicketService } from '../lib/service.mjs';
import { DirectoryTicketStore } from '../lib/stores/directory.mjs';
import { GitTreeTicketStore } from '../lib/stores/git-tree.mjs';

function makeTicket(id, extra = {}) {
  return {
    id,
    title: `Ticket ${id} — café 🚀`,
    category: 'feature',
    duration: 1,
    scope: ['src/**'],
    rails: [],
    edges: [],
    completed: false,
    ...extra,
  };
}

test('GitTreeTicketStore.load reads all directory shards in a single git cat-file --batch call with UTF-8 fidelity', (t) => {
  const { dir: root, g } = gitRepo(t, { prefix: 'adlc-gittree-batch-' });
  const storeDir = join(root, '.adlc/tickets');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, '.store.json'), `${JSON.stringify(ACTIVE_MANIFEST, null, 2)}\n`);
  const ids = ['T1', 'T2', 'T3', 'T4', 'T5'];
  for (const id of ids) {
    writeFileSync(join(storeDir, ticketFilename(id)), `${JSON.stringify(makeTicket(id), null, 2)}\n`);
  }
  g('add', '.');
  g('commit', '-q', '-m', 'seed 5 shards');

  const calls = [];
  const trackingSpawn = (cmd, args, opts) => {
    calls.push(args);
    return spawnSync(cmd, args, opts);
  };

  const store = new GitTreeTicketStore({ cwd: root, revision: 'HEAD', spawnFn: trackingSpawn });
  const snap = store.load();
  assert.equal(snap.tickets.length, 5);
  assert.equal(snap.get('T3').title, 'Ticket T3 — café 🚀');

  const catFileCalls = calls.filter((args) => args[0] === 'cat-file' && args[1] === '--batch');
  const shardShowCalls = calls.filter((args) => args[0] === 'show' && !args[1].endsWith('.store.json'));
  assert.equal(catFileCalls.length, 1, 'all 5 shards must be read in one git cat-file --batch call');
  assert.equal(shardShowCalls.length, 0, 'shards must not be read via per-shard git show calls');
});

test('GitTreeTicketStore rejects non-UTF-8 paths from ls-tree -z', (t) => {
  const fakeSpawn = (_cmd, args) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'a'.repeat(40) };
    if (args[0] === 'ls-tree') {
      return {
        status: 0,
        stdout: Buffer.concat([Buffer.from('100644 blob ' + 'b'.repeat(40) + '\t.adlc/tickets/'), Buffer.from([0xff, 0xfe]), Buffer.from('.json\0')]),
      };
    }
    return { status: 1, stderr: 'unexpected' };
  };
  const store = new GitTreeTicketStore({ cwd: tmp(t, 'gittree-utf8-'), revision: 'HEAD', spawnFn: fakeSpawn });
  assert.throws(() => store.load(), (err) => err.code === 'UNSAFE_GIT_PATH');
});

test('GitTreeTicketStore formats binary Buffer stderr into GIT_READ_FAILED without TypeError', (t) => {
  const fakeSpawn = (_cmd, args) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'a'.repeat(40) };
    if (args[0] === 'ls-tree') return { status: 128, stdout: Buffer.alloc(0), stderr: Buffer.from('fatal: bad object\n', 'utf8') };
    return { status: 1, stderr: 'unexpected' };
  };
  const store = new GitTreeTicketStore({ cwd: tmp(t, 'gittree-stderr-'), revision: 'HEAD', spawnFn: fakeSpawn });
  assert.throws(
    () => store.load(),
    (err) => err.code === 'GIT_READ_FAILED' && /fatal: bad object/.test(err.message),
  );
});

test('DirectoryTicketStore.loadOne and TicketService.loadOne read a single shard cleanly', (t) => {
  const root = tmp(t, 'adlc-loadone-');
  const storeDir = join(root, '.adlc/tickets');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, '.store.json'), `${JSON.stringify(ACTIVE_MANIFEST, null, 2)}\n`);
  writeFileSync(join(storeDir, ticketFilename('T1')), `${JSON.stringify(makeTicket('T1'), null, 2)}\n`);

  const store = new DirectoryTicketStore(storeDir);
  const service = new TicketService(store, { root });

  const found = service.loadOne('T1');
  assert.equal(found?.id, 'T1');
  assert.equal(Object.isFrozen(found), true);
  assert.equal(service.loadOne('MISSING'), null);
  assert.equal(store.loadOne(''), null);

  // Malformed ticket shard must be rejected by loadOne just like load()
  writeFileSync(join(store.path, ticketFilename('T-BAD')), JSON.stringify({ id: 'T-BAD' }), 'utf8');
  assert.throws(() => store.loadOne('T-BAD'), /ticket store validation failed/);
});

test('durableWrite and writeFileAtomic refuse writing through symlinks', (t) => {
  const dir = tmp(t, 'adlc-durability-sym-');
  const target = join(dir, 'target.txt');
  const link = join(dir, 'link.txt');
  writeFileSync(target, 'original', 'utf8');
  symlinkSync(target, link);

  assert.throws(() => durableWrite(link, 'overwrite'), /refusing to write through symlink/);
  assert.throws(() => writeFileAtomic(link, 'overwrite'), /refusing to write through symlink/);
  assert.equal(readFileSync(target, 'utf8'), 'original');
});

test('acquireTicketLock stale recovery: recovers dead/reused/remote locks but never steals a live same-host lock', (t) => {
  const root = tmp(t, 'adlc-lock-stale-');
  const lockDir = join(root, LOCK_DIRECTORY);
  mkdirSync(lockDir, { recursive: true });

  // 1. Live same-host lock past staleMs must NOT be stolen
  writeFileSync(
    join(lockDir, 'owner.json'),
    JSON.stringify({
      version: 1,
      pid: 4242,
      pidStartTime: 'start-4242',
      hostname: hostname(),
      startedAt: new Date(1_000).toISOString(),
      command: 'holder',
      transactionId: null,
    }),
  );
  assert.throws(
    () =>
      acquireTicketLock(root, {
        retries: 1,
        delayMs: 1,
        staleMs: 500,
        now: () => 999_999,
        isPidAlive: (pid) => pid === 4242,
        procStartTime: () => 'start-4242',
      }),
    (err) => err.code === 'LOCK_TIMEOUT',
  );

  // 2. Dead same-host lock past staleMs IS recovered
  const lock1 = acquireTicketLock(root, {
    retries: 2,
    delayMs: 1,
    staleMs: 500,
    now: () => 999_999,
    isPidAlive: () => false,
  });
  assert.equal(lock1.metadata.pid, process.pid);
  assert.equal(releaseTicketLock(lock1).released, true);

  // 3. Reused same-host PID (pidStartTime mismatch) past staleMs IS recovered
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, 'owner.json'),
    JSON.stringify({
      version: 1,
      pid: 4242,
      pidStartTime: 'old-start',
      hostname: hostname(),
      startedAt: new Date(1_000).toISOString(),
      command: 'holder',
      transactionId: null,
    }),
  );
  const lock2 = acquireTicketLock(root, {
    retries: 2,
    delayMs: 1,
    staleMs: 500,
    now: () => 999_999,
    isPidAlive: () => true,
    procStartTime: () => 'new-start',
  });
  assert.equal(releaseTicketLock(lock2).released, true);
});
