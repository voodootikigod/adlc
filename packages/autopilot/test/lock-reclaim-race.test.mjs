// Two starters can judge the same lock stale. Reclaim must remove only the lock
// it judged: a racer that reaches its quarantine rename after the winner has
// already published a fresh lock must hand that lock back and refuse, never
// delete it (two loops would then run on one repository).
//
// Regression test for a bugfix, not a spec criterion: absent from ac-registry.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, renameSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, readOwner, LockHeldError, LOCK_DIR_NAME, STALE_AFTER_MS } from '../lib/lock.mjs';
import { after } from './helpers/node-test.mjs';

// Every fixture the factories below mint; removed once this file's tests finish.
const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

const DEAD = { pidAlive: () => false, pidStartTimeOf: () => null };
const T0 = Date.parse('2026-08-28T12:00:00Z');
const LATER = () => T0 + STALE_AFTER_MS + 60_000;

function staleWorld() {
  const adlc = mkdtempSync(join(tmpdir(), 'ap-lock-race-'));
  fixtureDirs.add(adlc);
  acquireLock(adlc, { self: { pid: 999_999, pidStartTime: '1' }, probes: DEAD, now: () => T0, token: 'd'.repeat(64) });
  return { adlc, lockDir: join(adlc, LOCK_DIR_NAME), cleanup: () => rmSync(adlc, { recursive: true, force: true }) };
}

test('a reclaimer whose quarantine rename would move the WINNER\'s fresh lock hands it back and refuses', () => {
  const w = staleWorld();
  try {
    let winner = null;
    const racing = {
      renameSync: (from, to) => {
        // Between B's staleness judgment and B's rename, A reclaims the same stale lock and publishes its own.
        if (winner === null && from === w.lockDir && to.includes('.stale-')) {
          winner = acquireLock(w.adlc, { self: { pid: process.pid, pidStartTime: '2' }, probes: DEAD, now: LATER, token: 'a'.repeat(64) });
        }
        return renameSync(from, to);
      },
    };
    assert.throws(
      () => acquireLock(w.adlc, { self: { pid: process.pid, pidStartTime: '3' }, probes: DEAD, now: LATER, token: 'b'.repeat(64), fsImpl: racing }),
      (e) => e instanceof LockHeldError && e.owner?.token === 'a'.repeat(64),
      'the late reclaimer refuses, naming the winner');
    assert.equal(readOwner(w.lockDir)?.token, 'a'.repeat(64), 'the winner\'s lock is still in place');
    assert.equal(winner.heartbeat(), true, 'and the winner still holds it');
    assert.deepEqual(readdirSync(w.adlc).filter((n) => n.includes('.stale-')), [], 'no quarantine directory is left behind');
  } finally { w.cleanup(); }
});

test('a reclaimer that moves exactly the lock it judged stale removes it and publishes its own', () => {
  const w = staleWorld();
  try {
    const lock = acquireLock(w.adlc, { self: { pid: process.pid, pidStartTime: '3' }, probes: DEAD, now: LATER, token: 'b'.repeat(64) });
    assert.equal(readOwner(w.lockDir)?.token, 'b'.repeat(64));
    assert.deepEqual(readdirSync(w.adlc).filter((n) => n.includes('.stale-')), [], 'the stale lock was removed');
    assert.equal(lock.release(), true);
  } finally { w.cleanup(); }
});
