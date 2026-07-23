// session-state.mjs — user-scoped per-session control state (T64).
// Depth, seen tool_use_ids, and P5 markers live under ~/.adlc (or ADLC_CURSOR_STATE_DIR),
// not under the consumer workspace.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SESSION_TTL_MS } from '../constants.mjs';
import { sessionSafeId } from './session-identity.mjs';

export function resolveStateDir(env = process.env) {
  const override = typeof env.ADLC_CURSOR_STATE_DIR === 'string' && env.ADLC_CURSOR_STATE_DIR.trim()
    ? env.ADLC_CURSOR_STATE_DIR.trim()
    : null;
  return override || join(homedir(), '.adlc');
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function depthPath(stateDir, sessionId) {
  const name = sessionId
    ? `cursor-buildgate-depth-${sessionSafeId(sessionId)}.json`
    : 'cursor-buildgate-depth-anonymous.json';
  const path = join(stateDir, name);
  if (!path.startsWith(stateDir)) throw new Error('depth path escaped state dir');
  return path;
}

function markerPath(stateDir, sessionId) {
  const name = sessionId
    ? `cursor-p5-marker-${sessionSafeId(sessionId)}.json`
    : 'cursor-p5-marker-anonymous.json';
  const path = join(stateDir, name);
  if (!path.startsWith(stateDir)) throw new Error('marker path escaped state dir');
  return path;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function atomicWrite(path, value) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

/**
 * Leased lock around a state file. Fencing: commit only if ownership still matches.
 */
export function withStateLock(lockPath, fn, {
  now = Date.now(),
  leaseMs = 5_000,
  retries = 40,
  backoffMs = 25,
} = {}) {
  ensureDir(dirname(lockPath));
  const owner = `${process.pid}.${now}.${Math.random().toString(16).slice(2)}`;
  for (let i = 0; i < retries; i++) {
    try {
      if (existsSync(lockPath)) {
        const cur = readJson(lockPath);
        if (cur?.leaseUntil && cur.leaseUntil < now) {
          try { unlinkSync(lockPath); } catch { /* race */ }
        }
      }
      // exclusive create
      writeFileSync(lockPath, `${JSON.stringify({ owner, leaseUntil: now + leaseMs })}\n`, { flag: 'wx' });
      try {
        return fn({ owner, revalidate() {
          const cur = readJson(lockPath);
          if (!cur || cur.owner !== owner) throw new Error('STATE_LOCK_LOST');
        } });
      } finally {
        const cur = readJson(lockPath);
        if (cur?.owner === owner) {
          try { unlinkSync(lockPath); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      if (err?.code === 'EEXIST' || err?.message === 'STATE_LOCK_LOST') {
        Atomics.wait?.(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs);
        // fallback busy sleep without Atomics.wait in all envs
        const end = Date.now() + backoffMs;
        while (Date.now() < end) { /* spin */ }
        now = Date.now();
        continue;
      }
      throw err;
    }
  }
  throw new Error(`could not acquire state lock: ${lockPath}`);
}

/**
 * Bump per-session depth. Idempotent on non-empty tool_use_id.
 * Missing/invalid tool_use_id → per-delivery bump (no shared synthetic key).
 */
export function bumpDepthCounter(rootIgnored, {
  now = Date.now(),
  conversationId = null,
  sessionId = conversationId,
  toolUseId = null,
  ttlMs = SESSION_TTL_MS,
  env = process.env,
} = {}) {
  const stateDir = resolveStateDir(env);
  const path = depthPath(stateDir, sessionId);
  const lockPath = `${path}.lock`;

  return withStateLock(lockPath, ({ revalidate }) => {
    let data = readJson(path);
    const fresh = data
      && typeof data.updatedAt === 'number'
      && now - data.updatedAt >= 0
      && now - data.updatedAt <= ttlMs;
    if (!fresh) data = { count: 0, seen: {}, updatedAt: now, sessionId: sessionId ?? null };

    const seen = (data.seen && typeof data.seen === 'object') ? { ...data.seen } : {};
    // TTL-prune seen ids
    for (const [id, ts] of Object.entries(seen)) {
      if (typeof ts !== 'number' || now - ts > ttlMs) delete seen[id];
    }

    const id = typeof toolUseId === 'string' && toolUseId.trim() ? toolUseId.trim() : null;
    if (id && seen[id]) {
      revalidate();
      atomicWrite(path, { ...data, seen, updatedAt: now, sessionId: sessionId ?? null });
      return data.count ?? 0;
    }

    const next = (Number.isInteger(data.count) && data.count >= 0 ? data.count : 0) + 1;
    if (id) seen[id] = now;
    const record = { count: next, seen, updatedAt: now, sessionId: sessionId ?? null };
    revalidate();
    atomicWrite(path, record);
    return next;
  }, { now });
}

export function readDepth(sessionId, { env = process.env, now = Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
  const data = readJson(depthPath(resolveStateDir(env), sessionId));
  if (!data) return 0;
  const fresh = typeof data.updatedAt === 'number' && now - data.updatedAt >= 0 && now - data.updatedAt <= ttlMs;
  return fresh && Number.isInteger(data.count) ? data.count : 0;
}

/** Write P5 marker (fenced). `sessionId` null → anonymous marker file. */
export function writeP5Marker({ sessionId = null, ticketId, runId, env = process.env, now = Date.now() }) {
  if (!runId) throw new TypeError('writeP5Marker requires runId');
  const stateDir = resolveStateDir(env);
  const path = markerPath(stateDir, sessionId);
  const lockPath = `${path}.lock`;
  return withStateLock(lockPath, ({ revalidate }) => {
    const record = { ts: now, ticketId: ticketId ?? null, sessionId: sessionId ?? null, runId };
    revalidate();
    atomicWrite(path, record);
    return record;
  }, { now });
}

/** Compare-and-delete marker by runId. */
export function clearP5Marker({ sessionId, runId, env = process.env, now = Date.now() }) {
  const stateDir = resolveStateDir(env);
  const path = markerPath(stateDir, sessionId);
  const lockPath = `${path}.lock`;
  return withStateLock(lockPath, ({ revalidate }) => {
    const cur = readJson(path);
    revalidate();
    if (!cur) return false;
    if (runId && cur.runId !== runId) return false;
    try { unlinkSync(path); } catch { return false; }
    return true;
  }, { now });
}

export function readP5Marker(sessionId, { env = process.env, now = Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
  const cur = readJson(markerPath(resolveStateDir(env), sessionId));
  if (!cur) return null;
  if (typeof cur.ts !== 'number' || now - cur.ts > ttlMs) return null;
  // Named vs anonymous must never cross-restrict.
  if ((cur.sessionId ?? null) !== (sessionId ?? null)) return null;
  return cur;
}
