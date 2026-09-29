// apply-lock-ownership.test.mjs — liveness and ownership of the apply lock.
//
// LIVENESS: signal 0 to a process owned by another user throws EPERM, and that
// process is alive. Reading EPERM as "dead" recovers a live lock and puts two
// writers in one transaction.
//
// OWNERSHIP: a release removes the lock only while it is still this run's lock.
// A recoverer that loses the claim race hands the lock back; if a third run
// took the path in that window, an unconditional release by the original
// holder would delete the third run's live lock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { acquireApplyLock, pidAlive } from '../lib/io.mjs';

const LOCK = '/virtual/ledger.json.lock';

/** An in-memory directory tree with the fs semantics the lock relies on. */
function memoryFs() {
  const dirs = new Map(); // path -> { owner: string|null, ino }
  let nextIno = 1;
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const ownerDir = (p) => p.replace(/\/owner\.json$/, '');
  return {
    dirs,
    ownerAt: (p) => (dirs.get(p)?.owner ? JSON.parse(dirs.get(p).owner).pid : null),
    io: (pid, over = {}) => ({
      pid,
      mkdir: (p) => {
        if (dirs.has(p)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        dirs.set(p, { owner: null, ino: nextIno++ });
      },
      write: (p, body) => {
        const d = dirs.get(ownerDir(p));
        if (!d) throw enoent();
        d.owner = body;
      },
      read: (p) => {
        const d = dirs.get(ownerDir(p));
        if (!d || d.owner === null) throw enoent();
        return d.owner;
      },
      rename: (from, to) => {
        if (!dirs.has(from)) throw enoent();
        if (dirs.has(to)) throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' });
        dirs.set(to, dirs.get(from));
        dirs.delete(from);
      },
      rmdir: (p) => { dirs.delete(p); },
      stat: (p) => {
        const d = dirs.get(p);
        if (!d) throw enoent();
        return { ino: d.ino, mtimeMs: 0 };
      },
      alive: (candidate) => candidate !== 111,
      ...over,
    }),
  };
}

// ---- liveness --------------------------------------------------------------

test('pidAlive: a process we may not signal (EPERM) is alive', () => {
  const kill = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  assert.equal(pidAlive(1, kill), true);
});

test('pidAlive: a process that does not exist (ESRCH) is dead', () => {
  const kill = () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); };
  assert.equal(pidAlive(4242, kill), false);
});

test('pidAlive: a process we can signal is alive, and signal 0 is what is sent', () => {
  const seen = [];
  assert.equal(pidAlive(7, (pid, sig) => { seen.push([pid, sig]); return true; }), true);
  assert.deepEqual(seen, [[7, 0]]);
});

test('the default liveness probe treats another user\'s live process as a holder', () => {
  // pid 1 always exists; unprivileged, signalling it throws EPERM.
  const fs = memoryFs();
  const io = fs.io(222);
  delete io.alive;
  io.mkdir(LOCK);
  io.write(`${LOCK}/owner.json`, `${JSON.stringify({ pid: 1, startedAt: 'then' })}\n`);
  assert.throws(() => acquireApplyLock(LOCK, io), (err) => err.isOpError === true && /another apply run holds the lock/.test(err.message));
  assert.equal(fs.ownerAt(LOCK), 1, 'the live holder\'s lock is untouched');
});

// ---- ownership -------------------------------------------------------------

test('a release removes this run\'s own lock', () => {
  const fs = memoryFs();
  const release = acquireApplyLock(LOCK, fs.io(222));
  assert.equal(fs.ownerAt(LOCK), 222);
  release();
  assert.equal(fs.dirs.has(LOCK), false);
});

test('a release does not remove a lock another run now holds', () => {
  const fs = memoryFs();
  const release = acquireApplyLock(LOCK, fs.io(222));
  // The path now holds someone else's lock (however it got there).
  fs.dirs.delete(LOCK);
  const other = fs.io(444);
  other.mkdir(LOCK);
  other.write(`${LOCK}/owner.json`, `${JSON.stringify({ pid: 444, startedAt: 'now' })}\n`);
  release();
  assert.equal(fs.ownerAt(LOCK), 444);
});

test('a failed hand-back is fatal and names where the moved lock now sits; the third run\'s lock survives the first run\'s release', () => {
  const fs = memoryFs();
  // A stale lock left by dead pid 111.
  const seed = fs.io(111);
  seed.mkdir(LOCK);
  seed.write(`${LOCK}/owner.json`, `${JSON.stringify({ pid: 111, startedAt: 'then' })}\n`);

  let releaseA = null;
  let releaseC = null;
  let renames = 0;
  const bIo = fs.io(333);
  const realRename = bIo.rename;
  bIo.rename = (from, to) => {
    renames += 1;
    if (renames === 1) releaseA = acquireApplyLock(LOCK, fs.io(222)); // A recovers first
    if (renames === 2) releaseC = acquireApplyLock(LOCK, fs.io(444)); // C takes the empty path
    return realRename(from, to);
  };

  assert.throws(
    () => acquireApplyLock(LOCK, bIo),
    (err) => err.isOpError === true && /\.stale-333-/.test(err.message),
  );
  assert.equal(fs.ownerAt(LOCK), 444, 'C holds the path');

  releaseA();
  assert.equal(fs.ownerAt(LOCK), 444, 'A\'s release must not delete C\'s live lock');
  releaseC();
  assert.equal(fs.dirs.has(LOCK), false);
});
