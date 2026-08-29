// AC 22 — the single-instance lock: two concurrent starters → exactly one
// acquires; a dead pid with an 11-minute-old heartbeat is reclaimed; a live pid
// with a stale heartbeat is NOT; a reused pid with a different start time is;
// release with the wrong token is refused.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock, readOwner, isStale, LockHeldError, LOCK_DIR_NAME, STALE_AFTER_MS, lockHeldBy } from '../lib/lock.mjs';
import { withMutation } from '../lib/mutations.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'ap-lock-'));
const self = (pid = 1000, start = '111') => ({ pid, pidStartTime: start });
const probes = ({ alive = true, start = '111' } = {}) => ({ pidAlive: () => alive, pidStartTimeOf: () => start });
const NOW = Date.parse('2026-08-28T12:00:00Z');

export function ac22_twoStartersOneWins() {
  const dir = scratch();
  try {
    const a = acquireLock(dir, { self: self(1), probes: probes(), now: () => NOW });
    assert.ok(existsSync(join(dir, LOCK_DIR_NAME, 'owner.json')));
    let err = null;
    try { acquireLock(dir, { self: self(2), probes: probes(), now: () => NOW }); } catch (e) { err = e; }
    assert.ok(err instanceof LockHeldError); assert.equal(err.code, 'lock-held'); assert.equal(err.exitCode, 1);
    assert.equal(readOwner(join(dir, LOCK_DIR_NAME)).token, a.token, 'the first holder still owns it');
    assert.equal(lockHeldBy(dir, a.token), true);
    assert.equal(a.release(), true);
    assert.ok(!existsSync(join(dir, LOCK_DIR_NAME)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('AC22: two starters against the same dir → exactly one acquires, the other exits 1 lock-held', ac22_twoStartersOneWins);

export function ac22_reclaimRules() {
  const owner = (over = {}) => ({ pid: 1000, pidStartTime: '111', token: 'x', heartbeatAt: new Date(NOW - 11 * 60_000).toISOString(), ...over });
  assert.equal(isStale(owner(), { now: NOW, ...probes({ alive: false }) }), true, 'dead pid + 11-minute heartbeat → reclaimable');
  assert.equal(isStale(owner(), { now: NOW, ...probes({ alive: true, start: '111' }) }), false, 'LIVE pid + stale heartbeat → NOT reclaimable');
  assert.equal(isStale(owner(), { now: NOW, ...probes({ alive: true, start: '999' }) }), true, 'reused pid (different start time) → reclaimable');
  assert.equal(isStale(owner({ heartbeatAt: new Date(NOW - 60_000).toISOString() }), { now: NOW, ...probes({ alive: false }) }), false, 'a fresh heartbeat is never reclaimed, dead pid or not');
  assert.equal(STALE_AFTER_MS, 10 * 60_000);
  const dir = scratch();
  try {
    const a = acquireLock(dir, { self: self(1000, '111'), probes: probes(), now: () => NOW - 11 * 60_000 });
    // A LIVE holder with a stale heartbeat: a second starter must NOT reclaim.
    assert.throws(() => acquireLock(dir, { self: self(2), probes: probes({ alive: true, start: '111' }), now: () => NOW }), LockHeldError);
    // The same lock once the pid is dead: reclaimed, and the new owner has a new token.
    const b = acquireLock(dir, { self: self(2, '222'), probes: probes({ alive: false }), now: () => NOW });
    assert.notEqual(b.token, a.token);
    assert.equal(readOwner(join(dir, LOCK_DIR_NAME)).pid, 2);
    assert.equal(a.heartbeat(), false, 'the old holder can no longer heartbeat');
    assert.equal(b.heartbeat(), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('AC22: dead pid + 11-minute heartbeat is reclaimed; live pid + stale heartbeat is not; reused pid with another start time is', ac22_reclaimRules);

export async function ac22_releaseChecksToken() {
  const dir = scratch();
  try {
    const a = acquireLock(dir, { self: self(1), probes: probes(), now: () => NOW });
    assert.equal(releaseLock(join(dir, LOCK_DIR_NAME), 'wrong-token'), false, 'release with the wrong token is refused');
    assert.ok(existsSync(join(dir, LOCK_DIR_NAME)));
    await withMutation('lock.releaseAnyToken', () => { assert.equal(releaseLock(join(dir, LOCK_DIR_NAME), 'wrong-token'), true, 'seam: any token releases'); });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('AC22: release with the wrong token is refused (and the lock.releaseAnyToken seam removes that check)', ac22_releaseChecksToken);

export async function ac22_alwaysAcquireSeamBites() {
  const dir = scratch();
  try {
    acquireLock(dir, { self: self(1), probes: probes(), now: () => NOW });
    assert.throws(() => acquireLock(dir, { self: self(2), probes: probes(), now: () => NOW }), LockHeldError);
    await withMutation('lock.alwaysAcquire', () => { const b = acquireLock(dir, { self: self(2), probes: probes(), now: () => NOW }); assert.ok(b.token); });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('AC22: the lock.alwaysAcquire seam lets a second starter steal a live lock (the fixture the gate injects)', ac22_alwaysAcquireSeamBites);

export function ac22_corruptOwnerIsReclaimable() {
  const dir = scratch();
  try {
    const a = acquireLock(dir, { self: self(1), probes: probes(), now: () => NOW });
    writeFileSync(join(dir, LOCK_DIR_NAME, 'owner.json'), 'not json');
    const b = acquireLock(dir, { self: self(2), probes: probes(), now: () => NOW });
    assert.notEqual(b.token, a.token);
    assert.equal(JSON.parse(readFileSync(join(dir, LOCK_DIR_NAME, 'owner.json'), 'utf8')).pid, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('AC22: a lock directory with an unreadable owner file is stale and reclaimed atomically', ac22_corruptOwnerIsReclaimable);

export async function ac22_lockPublishIsAtomic() {
  // The lock directory must never be visible without its owner file: the owner is written into a
  // private staging directory and the directory is renamed into place (one publisher wins a race).
  const { LOCK_FS } = await import('../lib/lock.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ap-lock-atomic-'));
  try {
    const calls = [];
    const rec = (name) => (...a) => { calls.push([name, ...a.slice(0, 2).map(String)]); return LOCK_FS[name](...a); };
    const fsImpl = { mkdirSync: rec('mkdirSync'), mkdtempSync: rec('mkdtempSync'), writeFileSync: rec('writeFileSync'), renameSync: rec('renameSync'), rmSync: rec('rmSync') };
    const lock = acquireLock(dir, { self: self(1), probes: probes(), now: () => NOW, fsImpl });
    const lockDir = join(dir, LOCK_DIR_NAME);
    assert.ok(!calls.some(([n, p]) => n === 'mkdirSync' && p === lockDir), `the lock directory is never created empty: ${JSON.stringify(calls)}`);
    const publish = calls.findIndex(([n, , to]) => n === 'renameSync' && to === lockDir);
    const ownerWrite = calls.findIndex(([n, p]) => n === 'writeFileSync' && p.includes('.new-') && p.includes('owner.json'));
    assert.ok(publish > 0 && ownerWrite >= 0 && ownerWrite < publish, `the owner file is written into staging BEFORE the publish rename: ${JSON.stringify(calls)}`);
    assert.equal(readOwner(lockDir)?.token, lock.token, 'the published directory carries our owner');
    assert.ok(!existsSync(calls[publish][1]), 'the staging directory is gone after the publish');
    assert.throws(() => acquireLock(dir, { self: self(2), probes: probes(), now: () => NOW }), LockHeldError, 'a second acquirer is refused by the published directory');
    lock.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('AC22: the lock is PUBLISHED atomically — owner file staged first, directory renamed into place; no mkdir of the lock directory ever happens', ac22_lockPublishIsAtomic);

export async function ac22_releaseNeverRemovesAnotherOwnersLock() {
  // Between the owner read and the removal a reclaimer replaces the directory: the old owner's release must NOT delete the new lock.
  const dir = mkdtempSync(join(tmpdir(), 'ap-lock-release-race-'));
  try {
    const { LOCK_FS, releaseLock } = await import('../lib/lock.mjs');
    const lockDir = join(dir, LOCK_DIR_NAME);
    const a = acquireLock(dir, { self: self(1), probes: probes(), now: () => NOW });
    // The reclaim that lands in the gap: A's directory is quarantined and B publishes its own.
    let reclaimed = false;
    const reclaim = () => {
      if (reclaimed) return; reclaimed = true;
      renameSync(lockDir, `${lockDir}.stale-by-b`); rmSync(`${lockDir}.stale-by-b`, { recursive: true, force: true });
      const b = acquireLock(dir, { self: self(2), probes: probes(), now: () => NOW, token: 'b'.repeat(64) });
      assert.equal(b.token, 'b'.repeat(64));
    };
    const fsImpl = { renameSync: (from, to) => { if (from === lockDir) reclaim(); return LOCK_FS.renameSync(from, to); }, rmSync: (p, o) => { if (p === lockDir) reclaim(); return LOCK_FS.rmSync(p, o); } };
    const released = releaseLock(lockDir, a.token, { ino: a.ino, fsImpl });
    assert.equal(released, false, "A's release is refused: the directory is no longer A's");
    assert.equal(readOwner(lockDir)?.token, 'b'.repeat(64), "B's lock is intact after A's release attempt");
    assert.ok(!existsSync(`${lockDir}.release-${a.token}`), 'nothing left aside');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('AC22: a release that races a reclaim never removes the NEW owner\'s lock — the directory is moved aside and verified before removal', ac22_releaseNeverRemovesAnotherOwnersLock);
