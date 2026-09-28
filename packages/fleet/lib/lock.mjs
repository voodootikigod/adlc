// Single-instance repo lock with PID-reuse-proof stale recovery (spec §6.4;
// adversarial-review F5/N5).
//
// The lock is an atomic `mkdir .adlc/fleet.lock` — succeeds for exactly one
// writer. But "always released" only holds on a clean exit; a SIGKILL leaves it
// behind. So the lock carries owner metadata, and an existing lock is treated as
// LIVE only if a process with the recorded pid exists on the same host AND its
// start-time matches the recorded one — PIDs are reused, so pid-liveness alone
// would misclassify a stale lock as live (N5).

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_DIR = 'fleet.lock';

/** The fs surface `acquireLock` reclaims and publishes through (injectable so a test can interleave a racer). */
export const LOCK_FS = Object.freeze({ mkdirSync, writeFileSync, rmSync, renameSync });
const OWNER_FILE = 'owner.json';

function lockDirPath(dir) {
  return join(dir, LOCK_DIR);
}
function ownerPath(dir) {
  return join(lockDirPath(dir), OWNER_FILE);
}

/** Read the current lock owner metadata, or null if unlocked/unreadable. */
export function readLockOwner(dir) {
  return readOwnerIn(lockDirPath(dir));
}

/** The owner metadata inside a lock directory at `lockDir` (possibly moved aside), or null. */
function readOwnerIn(lockDir) {
  const p = join(lockDir, OWNER_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    // A lock dir with an unreadable owner file: treat as present-but-unknown.
    return { pid: null, host: null, corrupt: true };
  }
}

/**
 * Is the lock held by a genuinely-live orchestrator? PURE given the probes.
 *
 * @param owner            owner metadata ({pid, host, procStartTime})
 * @param probes.host      this host's identifier
 * @param probes.pidAlive  (pid) => boolean
 * @param probes.procStartTimeOf (pid) => string|null  (the live process's start time)
 */
export function isLockLive(owner, { host, pidAlive, procStartTimeOf }) {
  if (!owner || owner.corrupt) return false;
  if (owner.host !== host) return false; // different host → can't probe → not "live here"
  if (typeof owner.pid !== 'number') return false;
  if (!pidAlive(owner.pid)) return false; // dead pid → stale
  // PID-reuse defense (N5): the live process must be the SAME process, verified
  // by start-time. A reused pid on an unrelated process has a different start.
  const liveStart = procStartTimeOf(owner.pid);
  if (owner.procStartTime && liveStart && liveStart !== owner.procStartTime) return false;
  return true;
}

/** True when two owner readings describe the same lock (field for field). */
function sameOwner(a, b) {
  return a != null && b != null && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Try to acquire the lock. If an existing lock is stale (not live per the probes)
 * it is reclaimed first. Returns { acquired, refused, owner }.
 *
 * @param dir    the .adlc directory
 * @param self   this run's owner metadata { pid, host, runId, startedAt, procStartTime }
 * @param probes { host, pidAlive, procStartTimeOf } — for staleness classification
 * @param fsImpl  overrides for LOCK_FS
 */
export function acquireLock(dir, self, probes, fsImpl = {}) {
  const fsx = { ...LOCK_FS, ...fsImpl };
  const existing = readLockOwner(dir);
  if (existing) {
    if (isLockLive(existing, probes)) {
      return { acquired: false, refused: true, owner: existing };
    }
    // Stale (dead pid, pid reuse, other host's dead run, or corrupt) → reclaim
    // by renaming it aside to a per-actor quarantine name. The rename is atomic,
    // but a racer that judged the same stale owner may reach it only after the
    // winner re-created the lock, and would then move the WINNER's lock. So the
    // moved directory must be the lock judged stale; anything else is put back
    // and the reclaim refused.
    const quarantine = `${lockDirPath(dir)}.stale-${self.pid}-${self.procStartTime ?? 'x'}`;
    let moved = true;
    try {
      fsx.renameSync(lockDirPath(dir), quarantine);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // Someone else won the reclaim rename. Fall through to the mkdir attempt;
      // if they already re-created the lock, our mkdir EEXISTs and we refuse.
      moved = false;
    }
    if (moved) {
      const took = readOwnerIn(quarantine);
      if (!sameOwner(took, existing)) {
        try { fsx.renameSync(quarantine, lockDirPath(dir)); } catch { /* a newer lock appeared meanwhile; leave it */ }
        return { acquired: false, refused: true, owner: took ?? readLockOwner(dir) };
      }
      fsx.rmSync(quarantine, { recursive: true, force: true });
    }
  }
  // Atomic create: mkdir fails if another writer won the race in between.
  try {
    fsx.mkdirSync(lockDirPath(dir), { recursive: false });
  } catch (e) {
    if (e.code === 'EEXIST') return { acquired: false, refused: true, owner: readLockOwner(dir) };
    throw e;
  }
  fsx.writeFileSync(ownerPath(dir), JSON.stringify(self, null, 2) + '\n');
  return { acquired: true, refused: false, owner: self };
}

/** Release the lock unconditionally (clean-exit path). */
export function releaseLock(dir) {
  rmSync(lockDirPath(dir), { recursive: true, force: true });
}

/** Force-remove a lock (the guarded `fleet unlock` fallback). */
export function forceUnlock(dir) {
  const owner = readLockOwner(dir);
  releaseLock(dir);
  return owner;
}
