import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, readLockOwner, isLockLive, releaseLock, LOCK_DIR } from '../lib/lock.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'fleet-lock-'));
}
const HOST = 'host-a';
const self = (over = {}) => ({ pid: 4242, host: HOST, runId: 'r1', startedAt: 't', procStartTime: 'start-4242', ...over });

test('acquire on a clean dir succeeds and writes owner metadata', () => {
  const dir = tmp();
  const r = acquireLock(dir, self(), { host: HOST, pidAlive: () => false, procStartTimeOf: () => null });
  assert.equal(r.acquired, true);
  const owner = readLockOwner(dir);
  assert.equal(owner.pid, 4242);
  assert.equal(owner.procStartTime, 'start-4242');
});

test('a dead-pid lock is reclaimed (AC10 i / F5)', () => {
  const dir = tmp();
  // Seed a stale lock owned by a dead pid.
  mkdirSync(join(dir, LOCK_DIR));
  writeFileSync(join(dir, LOCK_DIR, 'owner.json'), JSON.stringify({ pid: 999, host: HOST, procStartTime: 'old' }));
  const r = acquireLock(dir, self(), { host: HOST, pidAlive: (pid) => pid === 4242, procStartTimeOf: () => null });
  assert.equal(r.acquired, true, 'dead-pid lock should be reclaimed');
  assert.equal(readLockOwner(dir).pid, 4242);
});

test('a live pid whose start-time mismatches is treated as PID reuse → reclaimed (AC10 ii / N5)', () => {
  const dir = tmp();
  mkdirSync(join(dir, LOCK_DIR));
  // Lock recorded pid 1234 with start-time 'boot-old'.
  writeFileSync(join(dir, LOCK_DIR, 'owner.json'), JSON.stringify({ pid: 1234, host: HOST, procStartTime: 'boot-old' }));
  // pid 1234 IS alive now, but it's an unrelated reused process with a NEW start-time.
  const probes = { host: HOST, pidAlive: (pid) => pid === 1234, procStartTimeOf: (pid) => (pid === 1234 ? 'boot-new' : null) };
  const owner = readLockOwner(dir);
  assert.equal(isLockLive(owner, probes), false, 'pid reuse must not count as live');
  const r = acquireLock(dir, self(), probes);
  assert.equal(r.acquired, true, 'pid-reuse stale lock should be reclaimed');
});

test('a genuinely live matching lock makes acquire refuse (AC10 iii)', () => {
  const dir = tmp();
  mkdirSync(join(dir, LOCK_DIR));
  writeFileSync(join(dir, LOCK_DIR, 'owner.json'), JSON.stringify({ pid: 1234, host: HOST, procStartTime: 'boot-1' }));
  const probes = { host: HOST, pidAlive: (pid) => pid === 1234, procStartTimeOf: (pid) => (pid === 1234 ? 'boot-1' : null) };
  const r = acquireLock(dir, self(), probes);
  assert.equal(r.acquired, false);
  assert.equal(r.refused, true, 'a live concurrent instance must block the run');
  assert.equal(readLockOwner(dir).pid, 1234, 'the live lock is left intact');
});

test('a lock from a different host is not treated as live-here', () => {
  const owner = { pid: 5, host: 'other-host', procStartTime: 'x' };
  assert.equal(isLockLive(owner, { host: HOST, pidAlive: () => true, procStartTimeOf: () => 'x' }), false);
});

test('after one reclaims a stale lock, a second attempt refuses (C3 single-holder invariant)', () => {
  const dir = tmp();
  mkdirSync(join(dir, LOCK_DIR));
  writeFileSync(join(dir, LOCK_DIR, 'owner.json'), JSON.stringify({ pid: 777, host: HOST, procStartTime: 'dead' }));
  // Realistic liveness: a pid is alive iff it's in `alive`; the stale owner 777
  // is not, but the successful reclaimer's own pid becomes alive.
  const alive = new Map();
  const probes = { host: HOST, pidAlive: (p) => alive.has(p), procStartTimeOf: (p) => alive.get(p) ?? null };
  const a = acquireLock(dir, self({ pid: 1001, procStartTime: 'a' }), probes);
  assert.equal(a.acquired, true, 'first reclaimer wins the stale lock');
  alive.set(1001, 'a'); // reclaimer A is now the running holder
  const b = acquireLock(dir, self({ pid: 1002, procStartTime: 'b' }), probes);
  assert.equal(b.acquired, false, 'a second attempt must not co-own A\'s live lock');
  assert.equal(b.refused, true);
  assert.equal(readLockOwner(dir).pid, 1001, 'A remains the sole holder');
});

test('releaseLock removes the lock', () => {
  const dir = tmp();
  acquireLock(dir, self(), { host: HOST, pidAlive: () => false, procStartTimeOf: () => null });
  releaseLock(dir);
  assert.equal(existsSync(join(dir, LOCK_DIR)), false);
});
