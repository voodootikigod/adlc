// workspace-resolve.mjs — ADLC-bearing root selection for Cursor hooks (T64).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve as pathResolve } from 'node:path';
import { detectTicketStore } from '@adlc/tickets';
import { ticketStoreExists } from '@adlc/core';
import { resolveActiveTicketAgainst } from '../generated-active-ticket.mjs';
import { SESSION_TTL_MS } from '../constants.mjs';
import { resolveStateDir, withStateLock } from './session-state.mjs';
import { sessionSafeId } from './session-identity.mjs';

/**
 * Normalize Cursor/Windows-style roots like `/c:/Users/...` to usable absolutes.
 */
export function normalizeRootPath(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p) return null;
  // Cursor Windows form: /c:/Users/... or /C:/...
  const win = p.match(/^\/([a-zA-Z]):\/(.*)$/);
  if (win) p = `${win[1]}:\\${win[2].replace(/\//g, '\\')}`;
  p = normalize(p);
  try {
    if (existsSync(p)) return pathResolve(p);
  } catch { /* keep lexical */ }
  return isAbsolute(p) ? p : null;
}

export function isAdlcBearing(root, env = process.env) {
  if (!root) return false;
  const override = env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS ?? null;
  if (ticketStoreExists(root, override)) return true;
  // Dual-store / pending tx still "bearing" for classification
  return existsSync(join(root, '.adlc', 'tickets.json'))
    || existsSync(join(root, '.adlc', 'tickets'))
    || existsSync(join(root, '.adlc', 'ticket-transactions'));
}

/**
 * Classify one ADLC-bearing root.
 */
export function classifyRoot(root, env = process.env) {
  let snapshot;
  try {
    const store = detectTicketStore({
      root,
      ticketStore: env.ADLC_TICKET_STORE,
      legacyTickets: env.ADLC_TICKETS,
      env,
    });
    snapshot = store.load();
  } catch (err) {
    return {
      kind: 'error-bearing',
      root,
      code: err?.code || 'STORE_LOAD',
      message: err?.message || String(err),
    };
  }

  const against = resolveActiveTicketAgainst(snapshot, { root, env, allowLegacyPointer: true });
  if (!against.ok) {
    return { kind: 'error-bearing', root, code: against.code, message: against.message };
  }
  if (!against.value) {
    return { kind: 'inactive', root, ticketId: null };
  }
  return {
    kind: 'active-ticket-bearing',
    root,
    ticketId: against.value.id,
    warnings: against.value.warnings ?? [],
  };
}

/**
 * Resolve consumer workspace from sessionStart / hook payload.
 */
export function resolveConsumerWorkspace(payload = {}, env = process.env) {
  const roots = [];
  const wr = payload.workspace_roots ?? payload.workspaceRoots;
  if (Array.isArray(wr)) {
    for (const r of wr) {
      const n = normalizeRootPath(r);
      if (n) roots.push(n);
    }
  }
  const envRoot = normalizeRootPath(env.CURSOR_PROJECT_DIR);
  if (envRoot) roots.push(envRoot);

  const unique = [...new Set(roots)];
  const bearing = unique.filter((r) => isAdlcBearing(r, env));
  const classified = bearing.map((r) => classifyRoot(r, env));

  const errors = classified.filter((c) => c.kind === 'error-bearing');
  if (errors.length) {
    return {
      outcome: 'error',
      root: null,
      ticketId: null,
      errorClass: errors[0].code,
      message: errors.map((e) => `${e.root}: ${e.message}`).join('; '),
      candidates: classified,
    };
  }

  const active = classified.filter((c) => c.kind === 'active-ticket-bearing');
  if (active.length === 1) {
    return {
      outcome: 'active',
      root: active[0].root,
      ticketId: active[0].ticketId,
      candidates: classified,
    };
  }
  if (active.length > 1) {
    return {
      outcome: 'ambiguous',
      root: null,
      ticketId: null,
      message: active.map((a) => `${a.root}→${a.ticketId}`).join('; '),
      candidates: classified,
    };
  }

  const inactive = classified.filter((c) => c.kind === 'inactive');
  if (inactive.length === 1) {
    return {
      outcome: 'inactive',
      root: inactive[0].root,
      ticketId: null,
      candidates: classified,
    };
  }
  if (inactive.length > 1) {
    const prefer = envRoot && inactive.find((i) => i.root === envRoot);
    const chosen = prefer || inactive.find((i) => unique.includes(i.root)) || inactive[0];
    return {
      outcome: 'inactive',
      root: chosen.root,
      ticketId: null,
      candidates: classified,
    };
  }

  // No ADLC-bearing candidates — unresolved (never plugin cwd)
  return {
    outcome: 'unresolved',
    root: null,
    ticketId: null,
    message: 'no host-supplied ADLC-bearing consumer root',
    candidates: classified,
  };
}

const INDEX_NAME = 'cursor-session-workspaces.json';

export function sessionIndexPath(env = process.env) {
  return env.ADLC_CURSOR_SESSION_INDEX?.trim()
    || join(resolveStateDir(env), INDEX_NAME);
}

/**
 * Upsert versioned session-resolution record (success or tombstone).
 * Whole-index leased lock + fencing before commit (AC19).
 */
export function upsertSessionResolution({
  sessionId,
  outcome,
  root = null,
  ticketId = null,
  candidates = null,
  errorClass = null,
  env = process.env,
  now = Date.now(),
  ttlMs = SESSION_TTL_MS,
}) {
  if (!sessionId) return null;
  const path = sessionIndexPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;

  return withStateLock(lockPath, ({ revalidate }) => {
    let index = { v: 1, sessions: {} };
    try {
      index = JSON.parse(readFileSync(path, 'utf8'));
      if (!index.sessions || typeof index.sessions !== 'object') index.sessions = {};
    } catch { /* fresh */ }

    // TTL-prune stale entries
    for (const [k, rec] of Object.entries(index.sessions)) {
      if (typeof rec?.ts !== 'number' || now - rec.ts > ttlMs) delete index.sessions[k];
    }

    const key = sessionSafeId(sessionId);
    const prev = index.sessions[key];
    const generation = (prev?.generation ?? 0) + 1;
    const record = {
      v: 1,
      sessionId,
      outcome,
      root,
      ticketId,
      candidates: candidates?.map((c) => ({ root: c.root, kind: c.kind, ticketId: c.ticketId ?? null })) ?? null,
      errorClass,
      generation,
      ts: now,
    };
    index.sessions[key] = record;
    revalidate();
    const tmp = `${path}.${process.pid}.${now}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
    renameSync(tmp, path);
    return record;
  }, { now });
}

export function readSessionResolution(sessionId, { env = process.env, now = Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
  if (!sessionId) return null;
  try {
    const index = JSON.parse(readFileSync(sessionIndexPath(env), 'utf8'));
    const rec = index?.sessions?.[sessionSafeId(sessionId)];
    if (!rec || typeof rec.ts !== 'number' || now - rec.ts > ttlMs) return null;
    return rec;
  } catch {
    return null;
  }
}

export function enforcementActive(env = process.env) {
  return env.ADLC_P4_ENFORCEMENT === '1';
}

export function phaseHint({ ticketId, enforcing }) {
  if (enforcing) return 'enforcing';
  if (ticketId) return 'ticketed';
  return 'idle';
}
