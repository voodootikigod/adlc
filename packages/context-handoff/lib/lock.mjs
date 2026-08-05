/**
 * Session lock: `.adlc/handoffs/<session_id>.lock`
 * Reclaim only when PID is dead AND the lock belongs to this host AND
 * {pid,started_at,host,nonce} fully match.
 */

import { unlinkSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
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

/** Lock schema written by acquireSessionLock; `unlock` matches on its fields. */
export const LOCK_SCHEMA = 1;

/** Hex byte count for lock nonces (load-bearing for hollow coverage). */
export const NONCE_HEX_BYTES = 8;

/**
 * Take a session's lock exclusively so deny-marker read-modify-write cannot
 * interleave. Creation is O_EXCL, not write-then-rename: a rename lets two
 * writers both believe they won. A dead lock from this host is reclaimed in
 * place; a live one — or any lock minted elsewhere — refuses with exit 2, since
 * a PID means nothing off the host that issued it.
 * @returns {{ ok: true, lock: object, path: string } | { ok: false, error: string, exitCode: number }}
 */
export function acquireSessionLock(
  root,
  sessionId,
  {
    pid = process.pid,
    startedAt = new Date().toISOString(),
    host = hostname(),
    nonce = randomBytes(NONCE_HEX_BYTES).toString('hex'),
  } = {},
  {
    fs = { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync },
    alive = isPidAlive,
  } = {},
) {
  const path = lockPath(root, sessionId);
  const lock = {
    schema: LOCK_SCHEMA,
    session_id: sessionId,
    pid,
    started_at: startedAt,
    host,
    nonce,
  };
  const body = `${JSON.stringify(lock, null, 2)}\n`;
  // Two passes at most: create, then create again after reclaiming one dead lock.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.writeFileSync(path, body, { encoding: 'utf8', flag: 'wx' });
      return { ok: true, lock, path };
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        return { ok: false, error: err?.code || err?.message || 'lock_write_failed', exitCode: 1 };
      }
    }
    const held = loadLock(root, sessionId, { fs });
    if (!held.ok) {
      return {
        ok: false,
        error: `session ${sessionId} is locked and the lock is unreadable (${held.error})`,
        exitCode: 2,
      };
    }
    if (String(held.lock.host) !== String(host)) {
      return {
        ok: false,
        error: `session ${sessionId} is locked by host "${held.lock.host}" — run there or reclaim it`,
        exitCode: 2,
      };
    }
    if (alive(Number(held.lock.pid))) {
      return {
        ok: false,
        error: `session ${sessionId} is locked by live pid ${held.lock.pid}`,
        exitCode: 2,
      };
    }
    try {
      fs.unlinkSync(path);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        return { ok: false, error: err?.code || err?.message || 'lock_unlink_failed', exitCode: 1 };
      }
    }
  }
  return { ok: false, error: `session ${sessionId} lock is contended`, exitCode: 2 };
}

/**
 * Drop a lock this process holds. The nonce check keeps a loser that reclaimed
 * nothing from deleting the winner's lock.
 * @returns {boolean} true when our lock was removed
 */
export function releaseSessionLock(
  root,
  sessionId,
  nonce,
  { fs = { existsSync, readFileSync, unlinkSync } } = {},
) {
  const held = loadLock(root, sessionId, { fs });
  if (!held.ok) return false;
  if (String(held.lock.nonce) !== String(nonce)) return false;
  try {
    fs.unlinkSync(lockPath(root, sessionId));
    return true;
  } catch {
    return false;
  }
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
