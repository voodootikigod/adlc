// compaction.mjs — T32: keep ADLC enforcement context alive across compaction,
// and stop a context-degraded high-risk session from auto-continuing past it.
//
// Two pure, injectable helpers wired into the experimental compaction hooks in
// index.mjs (signatures verified against @opencode-ai/plugin 1.17.17):
//   experimental.session.compacting(input, output:{ context: string[] })
//   experimental.compaction.autocontinue(input, output:{ enabled: boolean })
// No SDK, no host api — unit-testable offline.

import { buildSystemContext } from './context-inject.mjs';
import { checkBuildGate } from './build-gate.mjs';

/**
 * The context string(s) to APPEND to the compaction prompt so the active
 * ticket, frozen rails, and scope survive summarization (the same sanitized
 * block injected per-turn in Phase 3). Returns [] when there is nothing to say
 * (not an enforced ADLC build) so the hook is a clean no-op.
 * @returns {string[]}
 */
export function buildCompactionContext(root, env = process.env) {
  const block = buildSystemContext(root, env);
  return block ? [block] : [];
}

/**
 * Decide whether the post-compaction synthetic "continue" turn should fire.
 * Reuses the build-gate degradation predicate: when the SAME signal that denies
 * structured edits (high-risk ticket × context-degraded/compacted session) is
 * active, DISABLE autocontinue so a human turn is forced instead of the agent
 * barreling on with a freshly-summarized (lossy) context. Compaction itself is
 * a degradation signal, so on a high-risk ticket this fires by construction.
 *
 * The audited bypass is honored: ADLC_BUILD_GATE_BYPASS=1 turns the build-gate
 * deny into an allow (and records the override), so autocontinue stays enabled
 * — the operator explicitly opted out, and the override is on the manifest.
 *
 * @returns {{ enabled: boolean, reason: string, overridden: boolean }}
 */
export function decideAutocontinue({ sessionID, tracker, root = process.cwd(), env = process.env } = {}) {
  const gate = checkBuildGate({ sessionID, tracker, root, env });
  if (gate.decision === 'deny') {
    return { enabled: false, reason: gate.reason, overridden: false };
  }
  // allow — either not degraded/high-risk, or the bypass was exercised.
  return { enabled: true, reason: gate.reason, overridden: Boolean(gate.overridden) };
}
