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
const OWNER_FILE = 'owner.json';

function lockDirPath(dir) {
  return join(dir, LOCK_DIR);
}
function ownerPath(dir) {
  return join(lockDirPath(dir), OWNER_FILE);
}

/** Read the current lock owner metadata, or null if unlocked/unreadable. */
export function readLockOwner(dir) {
  const p = ownerPath(dir);
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

/**
 * Try to acquire the lock. If an existing lock is stale (not live per the probes)
 * it is reclaimed first. Returns { acquired, refused, owner }.
 *
 * @param dir    the .adlc directory
 * @param self   this run's owner metadata { pid, host, runId, startedAt, procStartTime }
 * @param probes { host, pidAlive, procStartTimeOf } — for staleness classification
 */
export function acquireLock(dir, self, probes) {
  const existing = readLockOwner(dir);
  if (existing) {
    if (isLockLive(existing, probes)) {
      return { acquired: false, refused: true, owner: existing };
    }
    // Stale (dead pid, pid reuse, other host's dead run, or corrupt) → reclaim
    // ATOMICALLY (adversarial-review C3). A blind rmSync-then-mkdir has a window
    // where a second reclaimer can delete the first's freshly-created lock. So
    // instead we rename the stale dir aside to a per-actor quarantine name:
    // `rename` is atomic and fails with ENOENT for every racer but the one that
    // wins, so exactly one process removes the stale lock. The loser then sees
    // either no lock (and races for mkdir) or a new live lock (and refuses).
    const quarantine = `${lockDirPath(dir)}.stale-${self.pid}-${self.procStartTime ?? 'x'}`;
    try {
      renameSync(lockDirPath(dir), quarantine);
      rmSync(quarantine, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // Someone else won the reclaim rename. Fall through to the mkdir attempt;
      // if they already re-created the lock, our mkdir EEXISTs and we refuse.
    }
  }
  // Atomic create: mkdir fails if another writer won the race in between.
  try {
    mkdirSync(lockDirPath(dir), { recursive: false });
  } catch (e) {
    if (e.code === 'EEXIST') return { acquired: false, refused: true, owner: readLockOwner(dir) };
    throw e;
  }
  writeFileSync(ownerPath(dir), JSON.stringify(self, null, 2) + '\n');
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
