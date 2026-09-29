// session-lock-reclaim.test.mjs — reclaiming a stale session-store lock removes
// only the lock that was judged stale. A reclaimer that loses the race to
// another reclaimer finds a live lock where the stale one was, and must hand it
// back instead of deleting it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { tmp } from '@adlc/core/test-kit';
import { LOCK_TTL_MS, judgeStaleLock, reclaimJudgedLock } from '../build-gate-inline.mjs';

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

function lockAt(t, owner) {
  const adlc = tmp(t, 'gemini-lock-');
  const lockDir = join(adlc, 'sessions.lock');
  mkdirSync(lockDir);
  if (owner !== undefined) writeFileSync(join(lockDir, 'owner.json'), JSON.stringify(owner));
  return { adlc, lockDir };
}

const STALE = () => Date.now() - LOCK_TTL_MS - 1000;

/** Another reclaimer wins: it removes the stale lock and takes a fresh one. */
function replaceWithLiveLock(lockDir, owner) {
  const moved = `${lockDir}.winner-claim`;
  renameSync(lockDir, moved);
  rmSync(moved, { recursive: true, force: true });
  mkdirSync(lockDir);
  if (owner !== undefined) writeFileSync(join(lockDir, 'owner.json'), JSON.stringify(owner));
}

function leftovers(adlc) {
  return readdirSync(adlc).filter((name) => name !== 'sessions.lock');
}

test('judgeStaleLock: a stale lock whose owner is dead is judged stale', (t) => {
  const { lockDir } = lockAt(t, { pid: deadPid(), nonce: 'old', time: STALE() });
  const judged = judgeStaleLock(lockDir);
  assert.ok(judged);
  assert.equal(judged.ownerRaw, readFileSync(join(lockDir, 'owner.json'), 'utf8'));
});

test('judgeStaleLock: a live owner, or a fresh lock, is never judged stale', (t) => {
  assert.equal(judgeStaleLock(lockAt(t, { pid: process.pid, nonce: 'n', time: STALE() }).lockDir), null);
  assert.equal(judgeStaleLock(lockAt(t, { pid: deadPid(), nonce: 'n', time: Date.now() }).lockDir), null);
  assert.equal(judgeStaleLock(lockAt(t).lockDir), null, 'a fresh owner-less lock is live');
  assert.equal(judgeStaleLock(join(tmp(t, 'gemini-lock-none-'), 'sessions.lock')), null);
});

test('judgeStaleLock: an owner-less or unparseable lock is stale only past the TTL', (t) => {
  const old = new Date(STALE());
  const ownerless = lockAt(t).lockDir;
  utimesSync(ownerless, old, old);
  const judged = judgeStaleLock(ownerless);
  assert.equal(judged.ownerRaw, null);
  assert.ok(judged.stat && judged.stat.ino > 0);

  const garbled = lockAt(t).lockDir;
  writeFileSync(join(garbled, 'owner.json'), '{"pid":');
  assert.equal(judgeStaleLock(garbled), null, 'a fresh unparseable lock is live');
  utimesSync(garbled, old, old);
  assert.equal(judgeStaleLock(garbled).ownerRaw, '{"pid":');
});

test('reclaimJudgedLock: an owner-less judged lock still in place is removed', (t) => {
  const { adlc, lockDir } = lockAt(t);
  const old = new Date(STALE());
  utimesSync(lockDir, old, old);
  assert.equal(reclaimJudgedLock(lockDir, judgeStaleLock(lockDir)), true);
  assert.deepEqual(readdirSync(adlc), []);
});

test('reclaimJudgedLock: the judged lock, still in place, is removed', (t) => {
  const { adlc, lockDir } = lockAt(t, { pid: deadPid(), nonce: 'old', time: STALE() });
  const judged = judgeStaleLock(lockDir);
  assert.equal(reclaimJudgedLock(lockDir, judged), true);
  assert.equal(existsSync(lockDir), false);
  assert.deepEqual(leftovers(adlc), []);
});

test('reclaimJudgedLock: a live lock that replaced the judged one is handed back intact', (t) => {
  const { adlc, lockDir } = lockAt(t, { pid: deadPid(), nonce: 'old', time: STALE() });
  const judged = judgeStaleLock(lockDir);
  const winner = { pid: process.pid, nonce: 'winner', time: Date.now() };
  replaceWithLiveLock(lockDir, winner);
  assert.equal(reclaimJudgedLock(lockDir, judged), false);
  assert.deepEqual(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')), winner);
  assert.deepEqual(leftovers(adlc), []);
});

test('reclaimJudgedLock: an owner-less lock replaced by another owner-less lock is handed back', (t) => {
  const { adlc, lockDir } = lockAt(t);
  const judged = { ownerRaw: null, stat: { ino: -1, mtimeMs: 0 } };
  replaceWithLiveLock(lockDir);
  assert.equal(reclaimJudgedLock(lockDir, judged), false);
  assert.equal(existsSync(lockDir), true);
  assert.deepEqual(leftovers(adlc), []);
});

test('reclaimJudgedLock: nothing to claim leaves nothing behind', (t) => {
  const adlc = tmp(t, 'gemini-lock-gone-');
  const lockDir = join(adlc, 'sessions.lock');
  assert.equal(reclaimJudgedLock(lockDir, { ownerRaw: 'x', stat: null }), false);
  assert.deepEqual(readdirSync(adlc), []);
});
