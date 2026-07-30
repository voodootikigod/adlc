// build-gate.mjs — the context-rot backstop for OpenCode (plan Phase 2.3,
// porting issue #48's build-gate to this harness).
//
// Decision logic is IMPORTED from @adlc/build-gate (the canonical package —
// the Claude Code hook carries a verbatim copy only because a PreToolUse hook
// cannot resolve npm at runtime; this plugin can, so it must not fork).
// The only OpenCode-specific part is the context-fitness SIGNAL: OpenCode has
// no transcript path a hook could scan, so the depth proxy is an in-plugin
// per-session tool-call counter, and a `session.compacted` event marks the
// session degraded outright (compaction IS the context-rot event).

import { isAbsolute, join } from 'node:path';
import { loadTickets, ticketStoreExists } from '@adlc/core';
import { computeRiskTier } from '@adlc/build-gate/lib/risk.mjs';
import { isDegraded, DEFAULT_DEPTH_THRESHOLD } from '@adlc/build-gate/lib/depth-signal.mjs';
import { decideBuildGate } from '@adlc/build-gate/lib/decide.mjs';
import { recordOverride } from '@adlc/build-gate/lib/override.mjs';
import { resolveActiveTicketId } from '../rails-checker.mjs';
import { getKey } from '@adlc/gate-manifest/lib/sign.mjs';

/**
 * Per-session context-fitness tracker. Pure state; the plugin instantiates one
 * per plugin load and feeds it from `tool.execute.before` (depth) and the
 * `session.compacted` event (hard degradation).
 */
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
 * The build-gate decision for one structured mutation in one session.
 * Fail-safe: any gap (uninitialized repo, no ticket, unknown ticket) allows —
 * the RAILS gate owns those denials; this gate exists solely for the
 * high-risk-ticket × degraded-context state.
 *
 * @returns {{ decision: 'allow'|'deny', reason: string, overridden?: boolean }}
 */
export function checkBuildGate({ sessionID, tracker, root = process.cwd(), env = process.env }) {
  if (env.ADLC_P4_ENFORCEMENT !== '1') {
    return { decision: 'allow', reason: 'enforcement inactive (ADLC_P4_ENFORCEMENT !== "1")' };
  }
  const override = env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS ?? null;
  const ticketsPath = override ? (isAbsolute(override) ? override : join(root, override)) : join(root, '.adlc', 'tickets.json');
  if (!ticketStoreExists(root, override)) {
    return { decision: 'allow', reason: 'repo not ADLC-initialized' };
  }
  const active = resolveActiveTicketId(root, env);
  if (active.conflict || !active.id) {
    return { decision: 'allow', reason: 'no unambiguous active ticket (rails gate owns conflict denial)' };
  }
  const { tickets } = loadTickets(ticketsPath);
  const ticket = tickets.find((t) => t.id === active.id);
  if (!ticket) {
    return { decision: 'allow', reason: `active ticket ${active.id} not found (rails gate owns that failure)` };
  }

  const { tier, signals } = computeRiskTier(ticket);
  const depth = tracker?.depth?.(sessionID) ?? 0;
  const depthThreshold = Number.parseInt(env.ADLC_BUILD_GATE_DEPTH_THRESHOLD ?? '', 10) || DEFAULT_DEPTH_THRESHOLD;
  const degraded =
    isDegraded({ depth, sessionBytes: 0, depthThreshold }) ||
    Boolean(tracker?.isCompacted?.(sessionID));

  const verdict = decideBuildGate({
    riskTier: tier,
    degraded,
    bypass: env.ADLC_BUILD_GATE_BYPASS === '1',
    recordBypass: () =>
      recordOverride({
        key: getKey(env),
        ticketId: active.id,
        signals,
        depth,
        sessionBytes: 0,
        reason: env.ADLC_BUILD_GATE_BYPASS_REASON || 'opencode in-session override',
        dir: join(root, '.adlc'),
      }),
  });
  if (verdict.decision === 'deny') {
    const cause = tracker?.isCompacted?.(sessionID) ? 'session was compacted' : `tool-call depth ${depth} > ${depthThreshold}`;
    return { ...verdict, reason: `${verdict.reason} [signal: ${cause}]` };
  }
  return verdict;
}
