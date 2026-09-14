/**
 * The adversarial gate (§3.6) — no GitHub write executes until a fresh-context
 * review confirms that specific write.
 *
 * THE ONE-SHOT PROPERTY IS ENFORCED HERE, IN THE CORE, and that placement is
 * the whole point. A wrapper told "review once" will, under pressure to finish,
 * reword the artifact and ask again until it gets an approve — which is exactly
 * the failure one-shot exists to prevent, and no amount of instruction text
 * stops it. So the verdict is recorded against `(issue, contentHash)` and a
 * second attempt for the same revision is REFUSED BY CODE. A changed artifact
 * for unchanged content is itself the tell.
 *
 * A refusal DEMOTES the action to a proposal. There is deliberately no
 * fix→re-review loop: for code there is something to fix, but a conclusion has
 * nothing to fix, so looping would only be retrying until the reviewer agrees.
 *
 * EVERYTHING THAT IS NOT AN EXPLICIT APPROVE IS A DEMOTE. The reviewer's exit
 * contract is 0 approve / 2 needs-attention / 1 error, and an error must never
 * read as an approve: "the review could not complete" and "the review found
 * nothing" are opposite facts that an exit-code truthiness check would merge.
 */

/** `adversarial-review` exit codes (its documented contract). */
export const REVIEW_APPROVE = 0;
export const REVIEW_NEEDS_ATTENTION = 2;

/**
 * The confidence floor for artifact-mode review.
 *
 * NOT the tool's 0.5 default: artifact-mode grounding halves every finding's
 * confidence, so at 0.5 material findings fall below the gate and the run
 * returns a hollow approve — an exit 0 that reviewed nothing.
 */
export const MIN_CONFIDENCE = 0.3;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Resolve the decider/reviewer pair, or say why there isn't one.
 *
 * Returns a REASON rather than throwing: an unavailable reviewer is routine
 * (quota exhausted, offline, a single provider configured) and must demote the
 * run's actions without destroying the read-only half of its value.
 */
export function reviewerPair(profile) {
  const providers = isPlainObject(profile?.providers) ? profile.providers : {};
  const decider = providers.decider;
  const reviewer = providers.reviewer;

  if (!decider) {
    // Without a declared decider the "distinct provider" rule is unenforceable:
    // the core cannot compare against something it was never told, and guessing
    // would let the rule pass on an assumption nobody made.
    return { ok: false, reason: 'providers.decider is not declared, so a distinct reviewer cannot be required' };
  }
  if (!reviewer) {
    return { ok: false, reason: 'providers.reviewer is not declared, so no second opinion is available' };
  }
  if (reviewer === decider) {
    return { ok: false, reason: `providers.reviewer (${reviewer}) is not distinct from providers.decider` };
  }
  return { ok: true, decider, reviewer };
}

/** The replay key: one verdict per issue per revision of the code it cites. */
export function gateKey({ number, contentHash } = {}) {
  return `${number}:${contentHash}`;
}

/**
 * The argv for one artifact review.
 *
 * Exactly ONE `--input`: batched artifacts do not converge, and a batched
 * verdict is not attributable to a specific action.
 */
export function reviewArgv({ artifactPath, reviewer, timeout = 600 } = {}) {
  return [
    '--input', artifactPath,
    '--provider', reviewer,
    '--min-confidence', String(MIN_CONFIDENCE),
    '--timeout', String(timeout),
    '--json',
  ];
}

/**
 * Build the reviewer runner the gate calls.
 *
 * IN LIB, NOT THE BINARY. Left in the bin these branches are reachable only by
 * spawning the process with a real reviewer behind it, so they go untested and a
 * flipped guard — reading a failed spawn as a verdict — passes every suite. That
 * is the one mistake this wrapper must not make, so it is tested here instead.
 *
 * @param {object} o
 * @param {Function} o.spawn - `(cmd, argv, opts) => {status, error}`
 */
export function makeReviewRunner({ spawn, artifactPath, reviewer, timeout = 600 } = {}) {
  return () => {
    const res = spawn('adversarial-review', reviewArgv({ artifactPath, reviewer, timeout }), {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    // A spawn that never ran has a NULL status, and `null` is not an exit code.
    // Returning it would let the gate compare null against 0 and, on any future
    // loosening of that comparison, read "never ran" as "approved".
    if (res?.error || res?.status === null || res?.status === undefined) {
      throw new Error(res?.error?.message ?? 'the reviewer did not run');
    }
    return { code: res.status };
  };
}

/**
 * Gate one proposed action.
 *
 * @param {object} o
 * @param {object} o.action - `{number, action, contentHash, evidence}`
 * @param {object} o.profile - parsed profile (supplies the provider pair)
 * @param {object} o.ledger - mutable replay ledger, keyed by `gateKey`
 * @param {Function} o.runReview - `() => {code:number}`; injected so the gate is
 *   testable without a reviewer, and so the CLI owns process spawning
 * @returns {{verdict:'approve'|'demote', reason:string|null}}
 */
export function gateAction({ action, profile, ledger = {}, runReview } = {}) {
  const pair = reviewerPair(profile);
  if (!pair.ok) return { verdict: 'demote', reason: pair.reason };

  if (!action?.contentHash) {
    // No revision to bind a verdict to means a replay would be undetectable, so
    // the one-shot guarantee does not exist for this action. Acting without it
    // would be acting on the one class of action the gate cannot protect.
    return { verdict: 'demote', reason: 'the action has no contentHash, so no gate verdict can be bound to a revision' };
  }

  const key = gateKey(action);
  if (Object.hasOwn(ledger, key)) {
    // The refusal is unconditional — it does not matter whether the prior
    // verdict was an approve or a demote, because "ask again and see" is the
    // bypass regardless of which way the first answer went.
    return {
      verdict: 'demote',
      reason: `this revision was already gated (verdict: ${ledger[key].verdict}); a second review of the same (issue, contentHash) is refused`,
    };
  }

  let code;
  try {
    const res = runReview();
    code = res?.code;
  } catch (err) {
    // A reviewer that could not run is not a reviewer that approved.
    return { verdict: 'demote', reason: `the review could not complete: ${err?.message ?? err}` };
  }

  const approved = code === REVIEW_APPROVE;
  const verdict = approved ? 'approve' : 'demote';
  const reason = approved
    ? null
    : code === REVIEW_NEEDS_ATTENTION
      ? 'the reviewer raised a material finding'
      : `the review could not complete (exit ${code})`;

  ledger[key] = {
    verdict,
    reason,
    reviewer: pair.reviewer,
    decider: pair.decider,
    contentHash: action.contentHash,
    number: action.number,
  };
  return { verdict, reason };
}
