// Two fleet runs can judge the same lock stale (a killed orchestrator's). The
// reclaim must remove only the lock it judged: a racer whose quarantine rename
// comes after the winner re-created the lock must hand it back and refuse,
// never delete it and run as a second orchestrator on the same .adlc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmp as makeTmp } from '@adlc/core/test-kit';
import { acquireLock, readLockOwner, LOCK_DIR } from '../lib/lock.mjs';

const HOST = 'host-a';
const DEAD_ONLY = { host: HOST, pidAlive: () => false, procStartTimeOf: () => null };
const self = (pid) => ({ pid, host: HOST, runId: `r${pid}`, startedAt: `t${pid}`, procStartTime: `s${pid}` });

function staleLock(t) {
  const dir = makeTmp(t, 'fleet-lock-race-');
  mkdirSync(join(dir, LOCK_DIR));
  writeFileSync(join(dir, LOCK_DIR, 'owner.json'), JSON.stringify({ pid: 777, host: HOST, procStartTime: 'dead' }));
  return dir;
}
const leftovers = (dir) => readdirSync(dir).filter((n) => n.includes('.stale-'));

test('a reclaimer whose quarantine rename would move the WINNER\'s fresh lock hands it back and refuses', (t) => {
  const dir = staleLock(t);
  let winner = null;
  const racing = {
    renameSync: (from, to) => {
      // Between B's staleness judgment and B's rename, A reclaims the same stale lock and re-creates it.
      if (winner === null && to.includes('.stale-')) winner = acquireLock(dir, self(1001), DEAD_ONLY);
      return renameSync(from, to);
    },
  };
  const b = acquireLock(dir, self(1002), DEAD_ONLY, racing);
  assert.equal(winner.acquired, true, 'A won the reclaim');
  assert.equal(b.acquired, false, 'B does not co-own the lock');
  assert.equal(b.refused, true);
  assert.equal(b.owner?.pid, 1001, 'B names the actual holder');
  assert.equal(readLockOwner(dir).pid, 1001, 'A\'s lock is still in place');
  assert.deepEqual(leftovers(dir), [], 'no quarantine directory is left behind');
});

test('a winner caught between its mkdir and its owner write is handed back too', (t) => {
  const dir = staleLock(t);
  const racing = {
    renameSync: (from, to) => {
      if (to.includes('.stale-') && readdirSync(dir).includes(LOCK_DIR)) {
        // A removed the stale lock and has only created the bare directory so far.
        renameSync(join(dir, LOCK_DIR), join(dir, 'gone'));
        mkdirSync(join(dir, LOCK_DIR));
      }
      return renameSync(from, to);
    },
  };
  const b = acquireLock(dir, self(1002), DEAD_ONLY, racing);
  assert.equal(b.acquired, false);
  assert.equal(b.refused, true);
  assert.deepEqual(readdirSync(join(dir, LOCK_DIR)), [], 'A\'s directory is back at the lock path, untouched');
});

test('a reclaimer that moves exactly the lock it judged stale removes it and takes the lock', (t) => {
  const dir = staleLock(t);
  const r = acquireLock(dir, self(1002), DEAD_ONLY);
  assert.equal(r.acquired, true);
  assert.equal(readLockOwner(dir).pid, 1002);
  assert.deepEqual(leftovers(dir), []);
});
