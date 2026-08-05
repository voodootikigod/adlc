/**
 * Session lock: `.adlc/handoffs/<session_id>.lock`
 * Reclaim only when PID is dead AND the lock belongs to this host AND
 * {pid,started_at,host,nonce} fully match.
 */

import { unlinkSync, existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { lockPath } from './paths.mjs';
import { readJsonFile, writeJsonAtomic } from './atomic-json.mjs';

/**
 * @param {number} pid
 * @param {{ kill?: (pid: number, signal: number) => void }} [deps]
 * @returns {boolean} true if the process appears alive
 */
export function isPidAlive(pid, { kill = (p, sig) => process.kill(p, sig) } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — alive.
    return err?.code === 'EPERM';
  }
}

/**
 * @returns {{ ok: true, lock: object } | { ok: false, error: string }}
 */
export function loadLock(root, sessionId, opts = {}) {
  const got = readJsonFile(lockPath(root, sessionId), opts);
  if (!got.ok) return { ok: false, error: got.error };
  return { ok: true, lock: got.value };
}

export function writeLock(root, sessionId, lock, opts = {}) {
  return writeJsonAtomic(lockPath(root, sessionId), lock, opts);
}

/**
 * Attempt unlock: require full field match, a lock owned by this host, and a dead PID.
 * A PID is only meaningful on the host that minted it, so a foreign-host lock is
 * never reclaimable here however dead the number looks locally.
 * @returns {{ ok: true, dryRun?: boolean, lock?: object } | { ok: false, error: string, exitCode: number }}
 */
export function unlockSession(
  root,
  { sessionId, pid, startedAt, host, nonce, write = false },
  {
    fs = { existsSync, unlinkSync, readFileSync },
    alive = isPidAlive,
    localHost = hostname(),
  } = {},
) {
  const path = lockPath(root, sessionId);
  const loaded = loadLock(root, sessionId, { fs });
  if (!loaded.ok) {
    return { ok: false, error: `lock ${loaded.error}`, exitCode: 1 };
  }
  const lock = loaded.lock;
  const expected = {
    pid: Number(pid),
    started_at: String(startedAt),
    host: String(host),
    nonce: String(nonce),
  };
  if (
    Number(lock.pid) !== expected.pid ||
    String(lock.started_at) !== expected.started_at ||
    String(lock.host) !== expected.host ||
    String(lock.nonce) !== expected.nonce
  ) {
    return { ok: false, error: 'lock field mismatch', exitCode: 2 };
  }
  if (String(lock.host) !== String(localHost)) {
    return {
      ok: false,
      error: `lock host "${lock.host}" is not this host "${localHost}" — reclaim on the owning host`,
      exitCode: 2,
    };
  }
  if (alive(expected.pid)) {
    return { ok: false, error: 'pid still alive', exitCode: 2 };
  }
  if (!write) {
    return { ok: true, dryRun: true, lock };
  }
  try {
    if (fs.existsSync(path)) fs.unlinkSync(path);
  } catch (err) {
    return { ok: false, error: err?.message || 'unlink_failed', exitCode: 1 };
  }
  return { ok: true, lock };
}
