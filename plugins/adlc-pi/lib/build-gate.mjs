// build-gate.mjs — the context-rot backstop for pi (spec Phase 2.1, porting
// issue #48's build-gate to this harness).
//
// Decision logic is IMPORTED from @adlc/build-gate (the canonical package);
// this module only supplies the pi-specific context-fitness SIGNAL. Unlike
// every sibling harness, pi exposes a REAL signal: ctx.getContextUsage()
// returns { tokens, contextWindow, percent }, so degradation is measured, not
// proxied by tool-call counts. A threshold/overflow compaction ALSO marks the
// session degraded outright — post-compaction usage shrinks, but compaction
// itself is the context-rot event (a summary replaced the ground truth).
// Activation follows pi's model: the active ticket is the switch.

import { computeRiskTier } from '@adlc/build-gate/lib/risk.mjs';
import { decideBuildGate } from '@adlc/build-gate/lib/decide.mjs';
import { recordOverride } from '@adlc/build-gate/lib/override.mjs';

/** Context-window fill percentage past which a session counts as degraded. */
export const DEFAULT_CONTEXT_PERCENT_THRESHOLD = 80;

/**
 * Per-session fitness tracker: remembers whether a non-manual compaction has
 * happened. Reset on session_start so a resumed/forked session starts clean.
 */
export function createFitnessTracker() {
  let compacted = false;
  return {
    markCompaction(reason) {
      if (reason === 'threshold' || reason === 'overflow') compacted = true;
    },
    reset() { compacted = false; },
    isCompacted: () => compacted,
  };
}

/**
 * The build-gate decision for one structured mutation. Fail-safe on gaps
 * (no ticket → allow; the rails gate owns those denials): this gate exists
 * solely for the high-risk-ticket × degraded-context state.
 *
 * @param {object} opts
 * @param {object} opts.ticket - the ACTIVE ticket (caller guarantees non-null)
 * @param {{tokens?:number, contextWindow?:number, percent?:number}|null} opts.usage
 *        the live ctx.getContextUsage() reading (null when unavailable)
 * @param {boolean} opts.compacted - fitness tracker verdict
 * @param {object} [opts.env]
 * @param {string} [opts.root] - repo root; the override ledger lives at <root>/.adlc
 * @returns {{ decision:'allow'|'deny', reason:string, overridden?:boolean }}
 */
export function checkBuildGate({ ticket, usage, compacted, env = process.env, root = process.cwd() }) {
  if (!ticket) return { decision: 'allow', reason: 'no active ticket — rails gate owns activation' };

  const threshold = Number(env.ADLC_BUILD_GATE_CONTEXT_PCT ?? DEFAULT_CONTEXT_PERCENT_THRESHOLD);
  const percent = Number(usage?.percent ?? 0);
  const degraded = compacted === true || (Number.isFinite(percent) && percent >= threshold);

  const { tier, signals } = computeRiskTier(ticket);
  return decideBuildGate({
    riskTier: tier,
    degraded,
    bypass: env.ADLC_BUILD_GATE_BYPASS === '1',
    recordBypass: () =>
      recordOverride({
        ticketId: ticket.id,
        signals,
        depth: Math.round(percent),
        sessionBytes: usage?.tokens ?? 0,
        reason: `pi context ${percent}% of window (compacted=${compacted === true})`,
        dir: `${root}/.adlc`,
      }),
  });
}
