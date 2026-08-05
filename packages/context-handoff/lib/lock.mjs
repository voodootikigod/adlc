/**
 * Session lock: `.adlc/handoffs/<session_id>.lock`
 * Reclaim only when PID is dead AND {pid,started_at,host,nonce} fully match.
 */

import { unlinkSync, existsSync, readFileSync } from 'node:fs';
import { lockPath } from './paths.mjs';
import { readJsonFile, writeJsonAtomic } from './atomic-json.mjs';

/**
 * @param {number} pid
 * @returns {boolean} true if the process appears alive
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
 * Attempt unlock: require full field match + dead PID.
 * @returns {{ ok: true, dryRun?: boolean, lock?: object } | { ok: false, error: string, exitCode: number }}
 */
export function unlockSession(
  root,
  { sessionId, pid, startedAt, host, nonce, write = false },
  {
    fs = { existsSync, unlinkSync, readFileSync },
    alive = isPidAlive,
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
