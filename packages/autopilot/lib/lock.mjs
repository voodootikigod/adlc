// Single-instance lock (spec §2.2, AC 22): `.adlc/autopilot.lock/` created with
// `mkdir` (atomic on POSIX). Inside, `owner.json = { pid, pidStartTime, token,
// heartbeatAt }`; the holder rewrites `heartbeatAt` every 60 s (temp + rename).
// Another starter may reclaim ONLY when the heartbeat is older than 10 minutes
// AND (the pid is not alive OR its /proc start time differs); reclaim is
// `rename(lockdir → lockdir.stale-<token>)` then `rmdir`, then a fresh `mkdir` —
// a losing racer's rename fails and it exits 1 `lock-held`. Release checks the
// token before removing.

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { active } from './mutations.mjs';

export const LOCK_DIR_NAME = 'autopilot.lock';
export const OWNER_FILE = 'owner.json';
export const HEARTBEAT_MS = 60_000;
export const STALE_AFTER_MS = 10 * 60_000;

export class LockHeldError extends Error {
  constructor(owner) { super('lock-held'); this.code = 'lock-held'; this.exitCode = 1; this.owner = owner ?? null; }
}

export const ownerPath = (lockDir) => join(lockDir, OWNER_FILE);

function writeAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
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
export function acquireLock(adlcDir, { self, probes, now = Date.now, token = randomBytes(32).toString('hex') } = {}) {
  const lockDir = join(adlcDir, LOCK_DIR_NAME);
  const existing = readOwner(lockDir);
  if (existing || existsSync(lockDir)) {
    // Mutation seam `lock.alwaysAcquire`: a LIVE lock is reclaimed anyway.
    if (!active('lock.alwaysAcquire') && !isStale(existing, { now: now(), ...probes })) throw new LockHeldError(existing);
    // Reclaim atomically: exactly one racer's rename succeeds.
    const quarantine = `${lockDir}.stale-${token}`;
    try { renameSync(lockDir, quarantine); rmSync(quarantine, { recursive: true, force: true }); }
    catch (e) { if (e.code !== 'ENOENT') throw new LockHeldError(readOwner(lockDir)); }
  }
  try { mkdirSync(lockDir, { recursive: false }); }
  catch (e) { if (e.code === 'EEXIST') throw new LockHeldError(readOwner(lockDir)); throw e; }
  const owner = { pid: self.pid, pidStartTime: self.pidStartTime ?? null, token, heartbeatAt: new Date(now()).toISOString() };
  writeAtomic(ownerPath(lockDir), owner);
  return {
    token, lockDir,
    heartbeat() {
      const cur = readOwner(lockDir);
      if (!cur || cur.token !== token) return false;
      writeAtomic(ownerPath(lockDir), { ...cur, heartbeatAt: new Date(now()).toISOString() });
      return true;
    },
    release() { return releaseLock(lockDir, token); },
  };
}

/** Release only if the owner file carries OUR token. */
export function releaseLock(lockDir, token) {
  const cur = readOwner(lockDir);
  // Mutation seam `lock.releaseAnyToken`: the token check is skipped.
  if (!cur || (!active('lock.releaseAnyToken') && cur.token !== token)) return false;
  rmSync(lockDir, { recursive: true, force: true });
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
