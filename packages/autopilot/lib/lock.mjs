// Single-instance lock (spec §2.2, AC 22): `.adlc/autopilot.lock/` created with
// `mkdir` (atomic on POSIX). Inside, `owner.json = { pid, pidStartTime, token,
// heartbeatAt }`; the holder rewrites `heartbeatAt` every 60 s (temp + rename).
// Another starter may reclaim ONLY when the heartbeat is older than 10 minutes
// AND (the pid is not alive OR its /proc start time differs); reclaim is
// `rename(lockdir → lockdir.stale-<token>)` then `rmdir`, then a fresh `mkdir` —
// a losing racer's rename fails and it exits 1 `lock-held`. Release checks the
// token before removing.

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, readdirSync, lstatSync } from 'node:fs';

registerSeams(['lock.twoStepPublish', 'lock.releaseByToken']);

/** The fs surface `acquireLock` publishes through (injectable so a test can record the ORDER of the steps). */
export const LOCK_FS = Object.freeze({ mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync });
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { registerSeams, active } from './mutations.mjs';

export const LOCK_DIR_NAME = 'autopilot.lock';
export const OWNER_FILE = 'owner.json';
export const HEARTBEAT_MS = 60_000;
export const STALE_AFTER_MS = 10 * 60_000;

export class LockHeldError extends Error {
  constructor(owner) { super('lock-held'); this.code = 'lock-held'; this.exitCode = 1; this.owner = owner ?? null; }
}

export const ownerPath = (lockDir) => join(lockDir, OWNER_FILE);

function writeAtomic(path, data, fsx = LOCK_FS) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fsx.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fsx.renameSync(tmp, path);
}

export function readOwner(lockDir) {
  const p = ownerPath(lockDir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { corrupt: true }; }
}

/**
 * PURE staleness rule given the probes.
 * @param probes.pidAlive (pid) => boolean
 * @param probes.pidStartTimeOf (pid) => string|null
 */
export function isStale(owner, { now = Date.now(), pidAlive, pidStartTimeOf }) {
  if (!owner) return true;
  if (owner.corrupt) return true;
  const heartbeat = Date.parse(owner.heartbeatAt ?? '');
  const heartbeatOld = Number.isNaN(heartbeat) || now - heartbeat > STALE_AFTER_MS;
  if (!heartbeatOld) return false;
  if (typeof owner.pid !== 'number' || !pidAlive(owner.pid)) return true;
  const live = pidStartTimeOf(owner.pid);
  return live != null && owner.pidStartTime != null && String(live) !== String(owner.pidStartTime);
}

/**
 * Acquire. Returns { token, lockDir, heartbeat(), release() }; throws LockHeldError.
 * `self` = { pid, pidStartTime }; `probes` as in isStale.
 */
export function acquireLock(adlcDir, { self, probes, now = Date.now, token = randomBytes(32).toString('hex'), fsImpl = null } = {}) {
  const fsx = fsImpl ? { ...LOCK_FS, ...fsImpl } : LOCK_FS;
  const lockDir = join(adlcDir, LOCK_DIR_NAME);
  const existing = readOwner(lockDir);
  if (existing || existsSync(lockDir)) {
    // Mutation seam `lock.alwaysAcquire`: a LIVE lock is reclaimed anyway.
    if (!active('lock.alwaysAcquire') && !isStale(existing, { now: now(), ...probes })) throw new LockHeldError(existing);
    // Reclaim atomically: exactly one racer's rename succeeds.
    const quarantine = `${lockDir}.stale-${token}`;
    try { fsx.renameSync(lockDir, quarantine); fsx.rmSync(quarantine, { recursive: true, force: true }); }
    catch (e) { if (e.code !== 'ENOENT') throw new LockHeldError(readOwner(lockDir)); }
  }
  const owner = { pid: self.pid, pidStartTime: self.pidStartTime ?? null, token, heartbeatAt: new Date(now()).toISOString() };
  if (active('lock.twoStepPublish')) {
    // Mutation seam `lock.twoStepPublish`: the directory appears BEFORE its owner file (the gap a
    // concurrent acquirer reads as "no owner" and reclaims).
    try { fsx.mkdirSync(lockDir, { recursive: false }); }
    catch (e) { if (e.code === 'EEXIST') throw new LockHeldError(readOwner(lockDir)); throw e; }
    writeAtomic(ownerPath(lockDir), owner, fsx);
  } else {
    // Atomic publish (codex r2 A6): the owner file is written into a private staging
    // directory FIRST and the directory is renamed into place, so the lock directory is
    // never visible without its owner. `rename` onto an existing non-empty directory
    // fails, so exactly one publisher wins a race.
    const staging = fsx.mkdtempSync(`${lockDir}.new-`);
    writeAtomic(ownerPath(staging), owner, fsx);
    try { fsx.renameSync(staging, lockDir); }
    catch (e) {
      fsx.rmSync(staging, { recursive: true, force: true });
      if (['ENOTEMPTY', 'EEXIST', 'EBUSY', 'EPERM'].includes(e.code)) throw new LockHeldError(readOwner(lockDir));
      throw e;
    }
  }
  let ino = null;
  try { ino = lstatSync(lockDir).ino; } catch { ino = null; }
  return {
    token, lockDir, ino,
    heartbeat() {
      const cur = readOwner(lockDir);
      if (!cur || cur.token !== token) return false;
      writeAtomic(ownerPath(lockDir), { ...cur, heartbeatAt: new Date(now()).toISOString() }, fsx);
      return true;
    },
    release() { return releaseLock(lockDir, token, { ino, fsImpl }); },
  };
}

/** Release only if the owner file carries OUR token. */
export function releaseLock(lockDir, token, { ino = null, fsImpl = null } = {}) {
  const fsx = fsImpl ? { ...LOCK_FS, ...fsImpl } : LOCK_FS;
  const cur = readOwner(lockDir);
  // Mutation seam `lock.releaseAnyToken`: the token check is skipped.
  if (!cur || (!active('lock.releaseAnyToken') && cur.token !== token)) return false;
  // Mutation seam `lock.releaseByToken`: read-then-remove (a reclaimer that replaced the directory
  // between the read and the removal loses ITS lock).
  if (active('lock.releaseByToken')) { fsx.rmSync(lockDir, { recursive: true, force: true }); return true; }
  // Release only the directory WE published (codex r5 A2): the inode must still be ours, and the
  // directory is moved aside first — if what moved is someone else's lock (a reclaim landed in the
  // gap), it is put back untouched.
  if (ino != null) { let st; try { st = lstatSync(lockDir); } catch { return false; } if (st.ino !== ino) return false; }
  const aside = `${lockDir}.release-${token}`;
  try { fsx.renameSync(lockDir, aside); } catch { return false; }
  const moved = readOwner(aside);
  if (!(active('lock.releaseAnyToken') || moved?.token === token)) {
    try { fsx.renameSync(aside, lockDir); } catch { /* a newer lock appeared meanwhile; leave it */ }
    return false;
  }
  fsx.rmSync(aside, { recursive: true, force: true });
  return true;
}

/** True iff a live holder exists (for the pre-strike helper's "lock-holding parent" check, §3.2). */
export function lockHeldBy(adlcDir, token) {
  const cur = readOwner(join(adlcDir, LOCK_DIR_NAME));
  return !!cur && cur.token === token;
}

/** Linux /proc start time (field 22), mirroring fleet's proc.mjs; null elsewhere. */
export function pidStartTimeOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2);
    return after.split(' ')[19] ?? null;
  } catch { return null; }
}
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export function selfIdentity() { return { pid: process.pid, pidStartTime: pidStartTimeOf(process.pid) }; }
export function defaultProbes() { return { pidAlive, pidStartTimeOf }; }
/** Stale-reclaim quarantine directories left by crashes (for status/forensics). */
export function staleDirs(adlcDir) {
  try { return readdirSync(adlcDir).filter((n) => n.startsWith(`${LOCK_DIR_NAME}.stale-`)); } catch { return []; }
}
