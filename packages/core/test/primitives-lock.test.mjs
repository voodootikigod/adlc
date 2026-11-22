import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '../lib/test-kit.mjs';
import { acquireDirLock, heartbeat, redactSecrets, withDirLock } from '../index.mjs';

test('acquireDirLock: writes complete owner metadata including hostname and leaves no staging dirs', (t) => {
  const dir = tmp(t, 'lock-meta-');
  const lockDir = join(dir, 'work.lock');

  const release = acquireDirLock(lockDir, { host: 'test-host-a', now: () => 10_000 });
  try {
    const entries = readdirSync(dir);
    assert.deepEqual(entries, ['work.lock']);
    const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.hostname, 'test-host-a');
    assert.equal(owner.token, release.token);
    assert.equal(owner.createdAt, 10_000);
  } finally {
    release();
  }
  assert.equal(existsSync(lockDir), false);
});

test('acquireDirLock: refuses to overwrite a fresh pre-existing empty lock directory', (t) => {
  const dir = tmp(t, 'lock-empty-fresh-');
  const lockDir = join(dir, 'empty.lock');
  mkdirSync(lockDir);

  assert.throws(
    () => acquireDirLock(lockDir, { staleMs: 60_000 }),
    (err) => err.code === 'EEXIST',
  );
  assert.equal(existsSync(join(lockDir, 'owner.json')), false);
  assert.deepEqual(readdirSync(dir), ['empty.lock']);
  rmSync(lockDir, { recursive: true, force: true });
});

test('acquireDirLock: never steals a live same-host lock on age alone, even with retries', (t) => {
  const dir = tmp(t, 'lock-live-same-host-');
  const lockDir = join(dir, 'live.lock');
  mkdirSync(lockDir);
  writeFileSync(
    join(lockDir, 'owner.json'),
    JSON.stringify({
      pid: 4242,
      pidStartTime: 'start-4242',
      hostname: 'host-a',
      token: 'live-token',
      createdAt: 1_000,
    }),
  );

  assert.throws(
    () =>
      acquireDirLock(lockDir, {
        staleMs: 500,
        retries: 1,
        delayMs: 1,
        host: 'host-a',
        now: () => 999_999,
        isPidAlive: (pid) => pid === 4242,
        procStartTime: () => 'start-4242',
      }),
    (err) => err.code === 'EEXIST',
  );
  const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
  assert.equal(owner.token, 'live-token');
  rmSync(lockDir, { recursive: true, force: true });
});

test('acquireDirLock: recovers stale lock on same-host PID reuse or remote-host expiry', (t) => {
  const dir = tmp(t, 'lock-recover-');

  // Case 1: same-host PID reused (pidStartTime mismatch)
  const reusedLock = join(dir, 'reused.lock');
  mkdirSync(reusedLock);
  writeFileSync(
    join(reusedLock, 'owner.json'),
    JSON.stringify({
      pid: 4242,
      pidStartTime: 'old-start',
      hostname: 'host-a',
      token: 'old-token',
      createdAt: 1_000,
    }),
  );
  const rel1 = acquireDirLock(reusedLock, {
    staleMs: 500,
    host: 'host-a',
    now: () => 5_000,
    isPidAlive: () => true,
    procStartTime: () => 'new-start',
  });
  try {
    const owner = JSON.parse(readFileSync(join(reusedLock, 'owner.json'), 'utf8'));
    assert.equal(owner.token, rel1.token);
    assert.notEqual(owner.token, 'old-token');
  } finally {
    rel1();
  }

  // Case 2: remote-host lock expired past staleMs
  const remoteLock = join(dir, 'remote.lock');
  mkdirSync(remoteLock);
  writeFileSync(
    join(remoteLock, 'owner.json'),
    JSON.stringify({
      pid: process.pid,
      hostname: 'other-host',
      token: 'remote-token',
      createdAt: 1_000,
    }),
  );
  const rel2 = acquireDirLock(remoteLock, {
    staleMs: 500,
    host: 'host-a',
    now: () => 5_000,
  });
  try {
    const owner = JSON.parse(readFileSync(join(remoteLock, 'owner.json'), 'utf8'));
    assert.equal(owner.token, rel2.token);
    assert.equal(owner.hostname, 'host-a');
  } finally {
    rel2();
  }
});

test('acquireDirLock: retries when lock becomes stale between attempts', (t) => {
  const dir = tmp(t, 'lock-retry-');
  const lockDir = join(dir, 'retry.lock');
  mkdirSync(lockDir);
  writeFileSync(
    join(lockDir, 'owner.json'),
    JSON.stringify({
      pid: 99999,
      hostname: 'host-a',
      token: 'expiring-token',
      createdAt: 1_000,
    }),
  );

  let ticks = 0;
  const release = acquireDirLock(lockDir, {
    staleMs: 500,
    retries: 2,
    delayMs: 1,
    host: 'host-a',
    isPidAlive: () => false,
    now: () => {
      ticks += 1;
      // First check sees age=100 (<= 500), second check sees age=2000 (> 500)
      return ticks <= 2 ? 1_100 : 3_000;
    },
  });
  try {
    const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
    assert.equal(owner.token, release.token);
  } finally {
    release();
  }
});

test('heartbeat: refreshes owned lock timestamp and refuses foreign or missing lock', (t) => {
  const dir = tmp(t, 'lock-heartbeat-');
  const lockDir = join(dir, 'hb.lock');
  let clock = 1_000;

  const release = acquireDirLock(lockDir, { now: () => clock });
  try {
    clock = 5_000;
    assert.equal(release.heartbeat(), true);
    const updated = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
    assert.equal(updated.createdAt, 5_000);
    assert.equal(updated.heartbeatAt, 5_000);

    // Foreign token must not refresh or clobber
    clock = 9_000;
    assert.equal(heartbeat(lockDir, 'wrong-token', { now: () => clock }), false);
    const unchanged = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
    assert.equal(unchanged.heartbeatAt, 5_000);
  } finally {
    release();
  }

  assert.equal(heartbeat(lockDir, release.token), false);
});

test('withDirLock: guarantees release on sync return, sync throw, and async resolve/reject', async (t) => {
  const dir = tmp(t, 'lock-with-');
  const lockDir = join(dir, 'with.lock');

  const syncVal = withDirLock(lockDir, ({ heartbeat: hb }) => {
    assert.equal(existsSync(lockDir), true);
    assert.equal(hb(), true);
    return 42;
  });
  assert.equal(syncVal, 42);
  assert.equal(existsSync(lockDir), false);

  assert.throws(
    () =>
      withDirLock(lockDir, () => {
        assert.equal(existsSync(lockDir), true);
        throw new Error('boom-sync');
      }),
    /boom-sync/,
  );
  assert.equal(existsSync(lockDir), false);

  const asyncVal = await withDirLock(lockDir, async ({ heartbeat: hb }) => {
    assert.equal(existsSync(lockDir), true);
    await Promise.resolve();
    assert.equal(hb(), true);
    return 'ok-async';
  });
  assert.equal(asyncVal, 'ok-async');
  assert.equal(existsSync(lockDir), false);

  await assert.rejects(
    () =>
      withDirLock(lockDir, async () => {
        assert.equal(existsSync(lockDir), true);
        await Promise.resolve();
        throw new Error('boom-async');
      }),
    /boom-async/,
  );
  assert.equal(existsSync(lockDir), false);
});

test('redactSecrets: derives rules from secret-shapes (inline assignments, private keys, full JWTs, case-insensitive bearer)', () => {
  assert.equal(redactSecrets('api_key=supersecretvalue123'), 'api_key=[REDACTED]');
  assert.equal(redactSecrets('bearer abcdefghijklmnopqrst12345'), '[REDACTED]');
  assert.equal(
    redactSecrets('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturePart123'),
    'token [REDACTED]',
  );
  assert.equal(
    redactSecrets('-----BEGIN RSA PRIVATE KEY-----'),
    '[REDACTED]',
  );
  // Case-sensitive AWS key prefix must not false-positive on lowercase
  assert.equal(redactSecrets('akia1234567890abcdef'), 'akia1234567890abcdef');
});
