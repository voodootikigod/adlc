// build-gate-inline.mjs — self-contained build-gate backstop for adlc-antigravity.
// Uses ONLY Node builtins (no npm @adlc/* runtime dependencies).

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadTickets, globMatch, ticketStoreExists } from './core-inline.mjs';
import { resolveActiveTicketId } from './rails-checker.mjs';
import { detectEditChurn } from './flail-inline.mjs';

export const DEFAULT_DEPTH_THRESHOLD = 50;
export const MAX_TRACKED_SESSIONS = 100;
export const TRUST_ROOT_PATHS = ['.adlc/tickets.json', '.adlc/tickets/**', '.adlc/current-ticket.json', '.adlc/sessions.json', '.adlc/sessions.lock/**'];
export const MANIFEST_PATH = '.adlc/manifest.jsonl';
export const HIGH_RISK_CATEGORIES = new Set(['contract', 'architecture']);

function touchesAny(globs, paths) {
  return (globs ?? []).some((g) => paths.some((p) => g === p || globMatch(g, p)));
}

function sleepSyncWithJitter(baseMs = 5) {
  const ms = baseMs + Math.floor(Math.random() * 5);
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback */ }
  }
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    return process.kill(pid, 0);
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

export function deriveRiskSignals(ticket) {
  const t = ticket ?? {};
  const signals = [];
  if (t.risk === 'high') signals.push('declared-risk-high');
  if (t.external === true) signals.push('external-system-effect');
  if (t.mutatesIdentity === true) signals.push('mutates-identity');

  if (t.scope !== undefined && !Array.isArray(t.scope)) signals.push('malformed-scope');
  if (t.rails !== undefined && !Array.isArray(t.rails)) signals.push('malformed-rails');

  const combinedGlobs = [
    ...(Array.isArray(t.scope) ? t.scope : []),
    ...(Array.isArray(t.rails) ? t.rails : []),
  ];

  if (touchesAny(combinedGlobs, [MANIFEST_PATH])) signals.push('mutates-manifest');
  if (touchesAny(combinedGlobs, TRUST_ROOT_PATHS)) {
    signals.push('touches-trust-root');
    signals.push('touches-trust-roots');
  }
  if (t.category && HIGH_RISK_CATEGORIES.has(t.category)) signals.push(`high-risk-category:${t.category}`);

  return signals;
}

export function computeRiskTier(ticket) {
  if (!ticket || typeof ticket !== 'object') {
    return { tier: 'normal', signals: [] };
  }
  const signals = deriveRiskSignals(ticket);
  return { tier: signals.length > 0 ? 'high' : 'normal', signals };
}

export function createDepthTracker() {
  const counts = new Map();
  const compacted = new Set();
  return {
    recordToolCall(sessionID) {
      if (!sessionID) return;
      counts.set(sessionID, (counts.get(sessionID) ?? 0) + 1);
    },
    markCompacted(sessionID) {
      if (!sessionID) return;
      compacted.add(sessionID);
    },
    depth(sessionID) {
      return counts.get(sessionID) ?? 0;
    },
    isCompacted(sessionID) {
      return compacted.has(sessionID);
    },
    isLockFailed() {
      return false;
    },
  };
}

/**
 * Universal session ID resolution for hooks and status display.
 */
export function resolveSessionId({ payload, env = process.env } = {}) {
  const candidate = payload?.conversationId ?? payload?.conversation_id ?? payload?.conversationID ?? payload?.sessionID ?? payload?.sessionId ?? payload?.params?.conversationId ?? payload?.params?.conversation_id ?? env?.ANTIGRAVITY_CONVERSATION_ID ?? env?.CONVERSATION_ID;
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return 'default_session';
}

/**
 * File-backed persistent session tracker with owner-checked & PID-probed mutex locking and LRU pruning.
 * Reclaims orphaned lock directories even if owner.json is missing when mtime > 3s.
 * Writes owner.json atomically via temp file to prevent torn reads under contention.
 * Self-healing lock failures and nonce-gated lock release.
 */
export function createPersistentTracker(root = process.cwd(), env = process.env) {
  const adlcDir = join(root, '.adlc');
  const storePath = join(adlcDir, 'sessions.json');
  const lockDir = join(adlcDir, 'sessions.lock');
  const ownerPath = join(lockDir, 'owner.json');

  const lockFailures = new Set();

  function writeOwnerFile(payload) {
    try {
      const tmpOwner = `${ownerPath}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmpOwner, JSON.stringify(payload));
      renameSync(tmpOwner, ownerPath);
    } catch {
      try { writeFileSync(ownerPath, JSON.stringify(payload)); } catch { /* ignore fallback write failure */ }
    }
  }

  function withLock(sessionID, fn, fallback = null) {
    let acquired = false;
    const nonce = `${process.pid}-${Date.now()}-${Math.random()}`;

    for (let i = 0; i < 100; i++) {
      try {
        mkdirSync(lockDir);
        writeOwnerFile({ pid: process.pid, nonce, time: Date.now() });
        acquired = true;
        if (sessionID) lockFailures.delete(sessionID);
        break;
      } catch {
        try {
          if (existsSync(lockDir)) {
            const stat = statSync(lockDir);
            const isStale = Date.now() - stat.mtimeMs > 3000;
            if (isStale) {
              let isDead = false;
              if (existsSync(ownerPath)) {
                try {
                  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
                  isDead = !isPidAlive(owner.pid);
                } catch {
                  isDead = true; // unreadable after >3s stale window → treat as dead
                }
              } else {
                isDead = true; // missing owner.json after >3s stale window → treat as dead
              }
              if (isDead) {
                try {
                  const tombstone = `${lockDir}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                  renameSync(lockDir, tombstone);
                  rmSync(tombstone, { recursive: true, force: true });
                } catch { /* another contender won the atomic rename race */ }
              }
            }
          }
        } catch { /* ignore */ }
        sleepSyncWithJitter(30);
      }
    }
    if (!acquired) {
      if (sessionID) lockFailures.add(sessionID);
      console.error(`[adlc-rails-guard] Warning: session lock acquisition timed out at ${lockDir}`);
      return fallback;
    }
    try {
      return fn();
    } finally {
      if (acquired) {
        try {
          if (existsSync(ownerPath)) {
            const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
            if (owner.nonce === nonce) {
              rmSync(lockDir, { recursive: true, force: true });
            }
          }
        } catch { /* ignore release errors */ }
      }
    }
  }

  function readStore() {
    try {
      if (existsSync(storePath)) {
        const store = JSON.parse(readFileSync(storePath, 'utf8'));
        // TTL check for default_session (1 hour) to avoid stale lockouts across days
        if (store.default_session && store.default_session.updatedAt && Date.now() - store.default_session.updatedAt > 3600000) {
          delete store.default_session;
        }
        return store;
      }
    } catch (err) {
      console.error(`[adlc-rails-guard] Warning: failed to parse session store: ${err.message}`);
    }
    return {};
  }

  function writeStore(data) {
    if (!ticketStoreExists(root, env)) return;
    try {
      if (!existsSync(adlcDir)) mkdirSync(adlcDir, { recursive: true });

      const keys = Object.keys(data);
      if (keys.length > MAX_TRACKED_SESSIONS) {
        const sorted = keys.sort((a, b) => (data[a]?.updatedAt ?? 0) - (data[b]?.updatedAt ?? 0));
        const toRemove = sorted.slice(0, keys.length - MAX_TRACKED_SESSIONS);
        for (const k of toRemove) delete data[k];
      }

      const tmpPath = `${storePath}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      renameSync(tmpPath, storePath);
    } catch (err) {
      console.error(`[adlc-rails-guard] Warning: failed to write session store: ${err.message}`);
    }
  }

  return {
    recordToolCall(sessionID) {
      if (!sessionID || !ticketStoreExists(root, env)) return;
      withLock(sessionID, () => {
        const store = readStore();
        const s = store[sessionID] ?? { depth: 0, compacted: false, edits: [] };
        s.depth = (s.depth ?? 0) + 1;
        s.updatedAt = Date.now();
        store[sessionID] = s;
        writeStore(store);
      });
    },
    markCompacted(sessionID) {
      if (!sessionID || !ticketStoreExists(root, env)) return;
      withLock(sessionID, () => {
        const store = readStore();
        const s = store[sessionID] ?? { depth: 0, compacted: false, edits: [] };
        s.compacted = true;
        s.updatedAt = Date.now();
        store[sessionID] = s;
        writeStore(store);
      });
    },
    recordEdit(sessionID, filePath) {
      if (!sessionID || !filePath || !ticketStoreExists(root, env)) return { churning: [] };
      return withLock(sessionID, () => {
        const store = readStore();
        const s = store[sessionID] ?? { depth: 0, compacted: false, edits: [], warned: [] };
        s.edits = s.edits ?? [];
        s.warned = s.warned ?? [];
        s.edits.push(`Editing ${filePath}`);
        if (s.edits.length > 200) s.edits = s.edits.slice(-200);

        const churns = detectEditChurn(s.edits, 3);
        const newlyChurning = churns.filter((c) => !s.warned.includes(c.path));
        for (const c of newlyChurning) s.warned.push(c.path);

        s.updatedAt = Date.now();
        store[sessionID] = s;
        writeStore(store);
        return { churning: newlyChurning };
      }, { churning: [] });
    },
    depth(sessionID) {
      if (!sessionID) return 0;
      const store = readStore();
      return store[sessionID]?.depth ?? 0;
    },
    isCompacted(sessionID) {
      if (!sessionID) return false;
      const store = readStore();
      return Boolean(store[sessionID]?.compacted);
    },
    isLockFailed(sessionID) {
      if (!sessionID) return false;
      return lockFailures.has(sessionID);
    },
  };
}

export function decideBuildGate({ riskTier, degraded, bypass, sessionID } = {}) {
  if (riskTier !== 'high') {
    return { decision: 'allow', reason: `ticket risk tier is '${riskTier ?? 'normal'}' — gate only guards high-risk tickets` };
  }
  if (!degraded) {
    return { decision: 'allow', reason: 'high-risk ticket, but context-fitness is not degraded' };
  }
  if (bypass) {
    return { decision: 'allow', reason: 'high-risk build in a degraded session, but ADLC_BUILD_GATE_BYPASS=1 was set', overridden: true };
  }
  if (sessionID === 'default_session') {
    return {
      decision: 'deny',
      reason: 'high-risk ticket build denied: context depth threshold exceeded in a session with unresolvable session ID (default_session). Delete .adlc/sessions.json or set ADLC_BUILD_GATE_BYPASS=1.',
    };
  }
  return {
    decision: 'deny',
    reason: 'high-risk ticket build denied: context depth threshold exceeded in this session. Resume in a fresh session before continuing.',
  };
}

export function checkBuildGate({ sessionID, tracker, root = process.cwd(), env = process.env }) {
  if (env.ADLC_P4_ENFORCEMENT !== '1') {
    return { decision: 'allow', reason: 'enforcement inactive' };
  }
  const override = env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS ?? null;
  const ticketsPath = override ? (isAbsolute(override) ? override : join(root, override)) : join(root, '.adlc', 'tickets.json');
  if (!ticketStoreExists(root, env)) {
    return { decision: 'allow', reason: 'repo not ADLC-initialized' };
  }
  const active = resolveActiveTicketId(root, env);
  if (active.conflict) {
    return { decision: 'deny', reason: 'ticket pointer conflict between ADLC_TICKET env and .adlc/current-ticket.json' };
  }
  if (!active.id) {
    return { decision: 'allow', reason: 'no unambiguous active ticket' };
  }
  const { tickets, errors } = loadTickets(ticketsPath);
  if (errors && errors.length > 0) {
    return { decision: 'deny', reason: `corrupt or unparseable ticket store: ${errors.join('; ')}` };
  }
  const ticket = tickets.find((t) => t.id === active.id);
  if (!ticket) {
    return { decision: 'deny', reason: `active ticket ${active.id} declared in current-ticket.json but not found in tickets.json` };
  }

  const { tier } = computeRiskTier(ticket);
  const depth = tracker?.depth?.(sessionID) ?? 0;
  const parsedThreshold = Number.parseInt(env.ADLC_BUILD_GATE_DEPTH_THRESHOLD ?? '', 10);
  const depthThreshold = Number.isNaN(parsedThreshold) ? DEFAULT_DEPTH_THRESHOLD : parsedThreshold;
  const degraded = depth >= depthThreshold || Boolean(tracker?.isCompacted?.(sessionID)) || Boolean(tracker?.isLockFailed?.(sessionID));

  const verdict = decideBuildGate({
    riskTier: tier,
    degraded,
    bypass: env.ADLC_BUILD_GATE_BYPASS === '1',
    sessionID,
  });

  if (verdict.decision === 'deny') {
    const cause = tracker?.isLockFailed?.(sessionID) ? 'session lock acquisition timed out (fail closed)' : tracker?.isCompacted?.(sessionID) ? 'session was compacted' : `tool-call depth ${depth} >= ${depthThreshold}`;
    return { ...verdict, reason: `${verdict.reason} [signal: ${cause}]` };
  }
  return verdict;
}
