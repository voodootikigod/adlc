// The blocking, cross-model prosecution gate (spec §8.4; adversarial-review F3).
//
// After the deterministic gates pass, every ticket is prosecuted by a real
// `adversarial-review` pass over the ticket-local diff (`startSha..HEAD`, N3) in
// a fresh context, preferring a different provider than built it. The gate is
// BLOCKING: a finding at/above the configured severity routes the ticket to the
// fix loop, not to merge; and if no review provider is reachable, it FAILS
// CLOSED (the ticket does not merge). The review runner is injectable so the
// orchestration is unit-testable with no live model call.

const SEVERITY_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * @param opts.runReview injectable: ({worktree, startSha}) => {
 *     ok:boolean,               // false = provider unreachable / review errored
 *     findings: [{severity}],   // parsed findings
 *   }
 * @param opts.failOn minimum blocking severity (default 'medium')
 * @returns { verdict:'pass'|'block'|'unavailable', blocking:[...], reason }
 */
export async function prosecute({ worktree, startSha, ticket }, { runReview, failOn = 'medium' } = {}) {
  if (typeof runReview !== 'function') {
    // No prosecutor wired at all → fail closed (must not silently pass).
    return { verdict: 'unavailable', blocking: [], reason: 'no review runner configured; failing closed' };
  }
  const threshold = SEVERITY_ORDER[failOn] ?? SEVERITY_ORDER.medium;
  let result;
  try {
    result = await runReview({ worktree, startSha, ticket });
  } catch (e) {
    return { verdict: 'unavailable', blocking: [], reason: `review runner threw: ${e.message}; failing closed` };
  }
  if (!result || result.ok === false) {
    // Provider unreachable / review could not complete → fail closed (F3): a
    // fleet that cannot prosecute must not auto-merge.
    return { verdict: 'unavailable', blocking: [], reason: result?.reason ?? 'review provider unreachable; failing closed' };
  }
  const blocking = (result.findings ?? []).filter(
    (f) => (SEVERITY_ORDER[f.severity] ?? 0) >= threshold
  );
  if (blocking.length > 0) {
    return { verdict: 'block', blocking, reason: `${blocking.length} finding(s) at/above ${failOn}` };
  }
  return { verdict: 'pass', blocking: [], reason: 'clean prosecution' };
}
