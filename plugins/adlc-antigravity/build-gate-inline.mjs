// build-gate-inline.mjs — self-contained build-gate backstop for adlc-antigravity.
// Uses ONLY Node builtins (no npm @adlc/* runtime dependencies).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadTickets, globMatch, ticketStoreExists } from './core-inline.mjs';
import { resolveActiveTicketId } from './rails-checker.mjs';
import { detectEditChurn } from './flail-inline.mjs';

export const DEFAULT_DEPTH_THRESHOLD = 50;

export const TRUST_ROOT_PATHS = ['.adlc/tickets.json', '.adlc/tickets/**', '.adlc/current-ticket.json'];
export const MANIFEST_PATH = '.adlc/manifest.jsonl';
export const HIGH_RISK_CATEGORIES = new Set(['contract', 'architecture']);

function touchesAny(globs, paths) {
  return (globs ?? []).some((g) => paths.some((p) => g === p || globMatch(g, p)));
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
  };
}

/**
 * File-backed persistent session tracker.
 * Persists depth, compaction, and edit log state to .adlc/sessions.json across process calls.
 */
export function createPersistentTracker(root = process.cwd()) {
  const adlcDir = join(root, '.adlc');
  const storePath = join(adlcDir, 'sessions.json');

  function readStore() {
    try {
      if (existsSync(storePath)) {
        return JSON.parse(readFileSync(storePath, 'utf8'));
      }
    } catch { /* ignore corrupted store */ }
    return {};
  }

  function writeStore(data) {
    try {
      if (!existsSync(adlcDir)) mkdirSync(adlcDir, { recursive: true });
      writeFileSync(storePath, JSON.stringify(data, null, 2));
    } catch { /* ignore write errors */ }
  }

  return {
    recordToolCall(sessionID) {
      if (!sessionID) return;
      const store = readStore();
      const s = store[sessionID] ?? { depth: 0, compacted: false, edits: [] };
      s.depth = (s.depth ?? 0) + 1;
      store[sessionID] = s;
      writeStore(store);
    },
    markCompacted(sessionID) {
      if (!sessionID) return;
      const store = readStore();
      const s = store[sessionID] ?? { depth: 0, compacted: false, edits: [] };
      s.compacted = true;
      store[sessionID] = s;
      writeStore(store);
    },
    recordEdit(sessionID, filePath) {
      if (!sessionID || !filePath) return { churning: [] };
      const store = readStore();
      const s = store[sessionID] ?? { depth: 0, compacted: false, edits: [], warned: [] };
      s.edits = s.edits ?? [];
      s.warned = s.warned ?? [];
      s.edits.push(`Editing ${filePath}`);
      if (s.edits.length > 200) s.edits = s.edits.slice(-200);

      const churns = detectEditChurn(s.edits, 3);
      const newlyChurning = churns.filter((c) => !s.warned.includes(c.path));
      for (const c of newlyChurning) s.warned.push(c.path);

      store[sessionID] = s;
      writeStore(store);
      return { churning: newlyChurning };
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
  };
}

export function decideBuildGate({ riskTier, degraded, bypass } = {}) {
  if (riskTier !== 'high') {
    return { decision: 'allow', reason: `ticket risk tier is '${riskTier ?? 'normal'}' — gate only guards high-risk tickets` };
  }
  if (!degraded) {
    return { decision: 'allow', reason: 'high-risk ticket, but context-fitness is not degraded' };
  }
  if (bypass) {
    return { decision: 'allow', reason: 'high-risk build in a degraded session, but ADLC_BUILD_GATE_BYPASS=1 was set', overridden: true };
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
  if (active.conflict || !active.id) {
    return { decision: 'allow', reason: 'no unambiguous active ticket' };
  }
  const { tickets } = loadTickets(ticketsPath);
  const ticket = tickets.find((t) => t.id === active.id);
  if (!ticket) {
    return { decision: 'allow', reason: `active ticket ${active.id} not found` };
  }

  const { tier } = computeRiskTier(ticket);
  const depth = tracker?.depth?.(sessionID) ?? 0;
  const depthThreshold = Number.parseInt(env.ADLC_BUILD_GATE_DEPTH_THRESHOLD ?? '', 10) || DEFAULT_DEPTH_THRESHOLD;
  const degraded = depth >= depthThreshold || Boolean(tracker?.isCompacted?.(sessionID));

  const verdict = decideBuildGate({
    riskTier: tier,
    degraded,
    bypass: env.ADLC_BUILD_GATE_BYPASS === '1',
  });

  if (verdict.decision === 'deny') {
    const cause = tracker?.isCompacted?.(sessionID) ? 'session was compacted' : `tool-call depth ${depth} >= ${depthThreshold}`;
    return { ...verdict, reason: `${verdict.reason} [signal: ${cause}]` };
  }
  return verdict;
}
