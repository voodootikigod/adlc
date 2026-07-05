// decide.mjs — the build-gate deny/allow decision (issue #48, item 3).
//
// Pure decision function. Deliberately takes already-computed inputs (risk
// tier, a boolean "degraded" context-fitness verdict, and a bypass flag) so
// it has zero I/O and is trivially unit-testable; the CLI/hook wire up the
// real risk derivation, depth signal, and override recording around it.
//
// Contract (mirrors the ADLC_RAILS_BYPASS pattern in
// plugins/adlc-claude-code/hooks/adlc-hook.mjs's rails() / recordBypass()):
//   - normal risk           → always allow, no matter how deep the session is.
//   - high risk, NOT deep   → allow (nothing to guard against yet).
//   - high risk, deep       → deny UNLESS an override is requested AND that
//                             override can be DURABLY RECORDED. An override
//                             that cannot be audited is refused, never
//                             silently honored — a silent bypass here would
//                             defeat the entire point of the gate.

/**
 * @param {object} opts
 * @param {'high'|'normal'} opts.riskTier
 * @param {boolean} opts.degraded - the context-fitness verdict (depth/bytes past threshold)
 * @param {boolean} opts.bypass - was an override requested (e.g. ADLC_BUILD_GATE_BYPASS=1)?
 * @param {() => boolean} [opts.recordBypass] - side effect that durably records the
 *   override; must return true only on a confirmed successful write. Called ONLY
 *   when the override is actually needed (high risk AND degraded AND bypass).
 * @returns {{ decision: 'allow'|'deny', reason: string, overridden?: boolean }}
 */
export function decideBuildGate({ riskTier, degraded, bypass, recordBypass } = {}) {
  if (riskTier !== 'high') {
    return { decision: 'allow', reason: `ticket risk tier is '${riskTier ?? 'normal'}' — gate only guards high-risk tickets` };
  }

  if (!degraded) {
    return { decision: 'allow', reason: 'high-risk ticket, but the context-fitness signal is not degraded (below threshold)' };
  }

  // High risk AND degraded — the one state the gate exists to catch.
  if (bypass) {
    const recorded = typeof recordBypass === 'function' && recordBypass() === true;
    if (recorded) {
      return { decision: 'allow', reason: 'high-risk build in a degraded session, but an audited override was recorded', overridden: true };
    }
    return {
      decision: 'deny',
      reason:
        'override requested but could not be durably recorded to the gate-manifest — ' +
        'an unaudited bypass is refused',
    };
  }

  return {
    decision: 'deny',
    reason:
      'high-risk ticket build denied: the context-fitness signal is past threshold in this session. ' +
      'Resume in a fresh session (or an isolated subagent) rather than continuing here.',
  };
}
