// build-gate-inline.mjs — self-contained build-gate backstop for adlc-antigravity.
// Uses ONLY Node builtins (no npm @adlc/* runtime dependencies).

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadTickets, globMatch, ticketStoreExists } from './core-inline.mjs';
import { resolveActiveTicketId } from './rails-checker.mjs';
import { detectEditChurn } from './flail-inline.mjs';

export const DEFAULT_DEPTH_THRESHOLD = 50;
export const MAX_TRACKED_SESSIONS = 100;

export const TRUST_ROOT_PATHS = ['.adlc/tickets.json', '.adlc/tickets/**', '.adlc/current-ticket.json'];
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
  if (touchesAny(combinedGlobs, TRUST_ROOT_PATHS)) signals.push('touches-trust-root');
  if (HIGH_RISK_CATEGORIES.has(t.category)) signals.push(`high-risk-category:${t.category}`);

  return signals;
}

export function computeRiskTier(ticket) {
  const signals = deriveRiskSignals(ticket);
  return { tier: signals.length > 0 ? 'high' : 'normal', signals };
}

export function createDepthTracker() {
  const depth = new Map();
  const compacted = new Set();
  return {
    recordToolCall(sessionID) {
      if (!sessionID) return;
      depth.set(sessionID, (depth.get(sessionID) ?? 0) + 1);
    },
    markCompacted(sessionID) {
      if (sessionID) compacted.add(sessionID);
    },
    depth(sessionID) {
      return depth.get(sessionID) ?? 0;
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
  const candidate = payload?.conversationId ?? payload?.conversation_id ?? payload?.conversationID ?? env?.ANTIGRAVITY_CONVERSATION_ID;
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return 'default_session';
}

/**
 * File-backed persistent session tracker with owner-checked & PID-probed mutex locking and LRU pruning.
 * Reclaims orphaned lock directories even if owner.json is missing when mtime > 3s.
 * Fails closed (isLockFailed=true) on lock acquisition timeout.
 */
export function createPersistentTracker(root = process.cwd(), env = process.env) {
  const adlcDir = join(root, '.adlc');
  const storePath = join(adlcDir, 'sessions.json');
  const lockDir = join(adlcDir, 'sessions.lock');
  const ownerPath = join(lockDir, 'owner.json');

  const lockFailures = new Set();

  function withLock(sessionID, fn, fallback = null) {
    let acquired = false;
    const nonce = `${process.pid}-${Date.now()}-${Math.random()}`;

    for (let i = 0; i < 40; i++) {
      try {
        mkdirSync(lockDir);
        try {
          writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, nonce, time: Date.now() }));
        } catch { /* owner write optional */ }
        acquired = true;
        break;
      } catch {
        try {
          if (existsSync(lockDir)) {
            const stat = statSync(lockDir);
            const isStale = Date.now() - stat.mtimeMs > 3000;
            let isDead = true;
            if (existsSync(ownerPath)) {
              try {
                const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
                isDead = !isPidAlive(owner.pid);
              } catch { /* ignore parse error */ }
            }
            if (isStale && isDead) {
              try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
            }
          }
        } catch { /* ignore */ }
        sleepSyncWithJitter(5);
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
          } else {
            rmSync(lockDir, { recursive: true, force: true });
          }
        } catch { /* ignore release errors */ }
      }
    }
  }

  function readStore() {
    try {
      if (existsSync(storePath)) {
        return JSON.parse(readFileSync(storePath, 'utf8'));
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
      reason: 'high-risk ticket build denied: context depth threshold exceeded in a session with unresolvable session ID (default_session). Resume in a fresh session or set ADLC_BUILD_GATE_BYPASS=1.',
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
    return { decision: 'allow', reason: `active ticket ${active.id} not found` };
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
