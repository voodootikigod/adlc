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

import { createHash } from 'node:crypto';

import { sealLedgerEntry, verifyLedgerEntry } from './ledger-sig.mjs';

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

/**
 * True when the ledger entry matches the action's slot identity.
 *
 * Slot identity is issue, action, field and revision, and deliberately not the
 * artifact digest, so rewording an artifact cannot buy a second review.
 *
 * @param {object} entry
 * @param {object} action
 * @returns {boolean}
 */
export function entryBindsSlot(entry, action) {
  return (
    entry?.contentHash === action?.contentHash &&
    entry?.number === action?.number &&
    entry?.action === action?.action &&
    (entry?.field ?? null) === (action?.field ?? null)
  );
}

/**
 * True when the ledger entry is bound to the slot and to the reviewed artifact digest.
 *
 * Action binding adds the digest because a signature covers an entry's content,
 * not the slot it is filed under, and because one slot is shared by a relabel to
 * two different targets and by a close carrying different evidence.
 *
 * @param {object} entry
 * @param {object} action
 * @returns {boolean}
 */
export function entryBindsAction(entry, action) {
  return (
    entryBindsSlot(entry, action) &&
    typeof entry?.artifactDigest === 'string' &&
    entry.artifactDigest === artifactDigest(action)
  );
}

/**
 * True when the ledger holds a SIGNED entry bound to this exact action.
 *
 * The shared precondition of both authorization reads: signed under our key, and
 * about this action rather than merely stored under its key.
 */
export function ledgerEntryFor(ledger, action, key = null) {
  const entry = ledger?.[gateKey(action ?? {})];
  if (!entry) return null;
  if (!verifyLedgerEntry(key, entry)) return null;
  if (!entryBindsAction(entry, action)) return null;
  return entry;
}

/**
 * True when the ledger holds an APPROVE bound to this exact action's revision.
 *
 * The authority on whether a write is licensed. A caller-supplied `gate` object
 * is a claim, not authorization: any library caller can construct one, and
 * trusting it would put the whole gate behind an `if` the caller controls.
 *
 * SIGNATURE FIRST (#1035). Every other field below is one the caller can
 * compute — `artifactDigest` is exported and pure — so field checks alone made
 * the ledger a place to write an approval rather than a record of one. Without a
 * key nothing verifies, and nothing is authorized: the run still proposes, and a
 * write becomes a key-holder act.
 */
export function ledgerApproves(ledger, action, key = null) {
  return ledgerEntryFor(ledger, action, key)?.verdict === 'approve';
}

/**
 * The digest of exactly what the reviewer is shown for an action.
 *
 * Recorded with every verdict and required by `ledgerApproves`, so an approval
 * covers the artifact that was reviewed and nothing that merely shares its key.
 */
export function artifactDigest(action) {
  return createHash('sha256').update(buildActionArtifact(action ?? {})).digest('hex');
}

/** The replay key: one verdict per issue per revision of the code it cites. */
export function gateKey({ number, contentHash, action, field = null } = {}) {
  // The ACTION is part of the key. Without it a close and a relabel on the same
  // issue at the same revision collide: whichever is gated first records the
  // key, and the second is refused as a replay of a decision that was never
  // about it.
  // FIELD too: a priority relabel and an area relabel on one issue share both
  // the action and the revision, so without it the first to be gated records the
  // key and the second is refused as a replay of a decision about something else.
  return `${number}:${action}${field ? `:${field}` : ''}:${contentHash}`;
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
export function gateAction({ action, profile, ledger = {}, runReview, key = null } = {}) {
  const pair = reviewerPair(profile);
  if (!pair.ok) return { verdict: 'demote', reason: pair.reason };

  // NO KEY, NO REVIEW — checked before anything is spawned. A verdict recorded
  // without a signature can never authorize a write (#1035), so running the
  // reviewer here would spend real provider budget on an answer nothing can act
  // on AND burn the one-shot: the revision would be marked gated, so the run
  // that DOES hold the key would be refused as a replay.
  if (typeof key !== 'string' || key.length === 0) {
    return { verdict: 'demote', reason: 'no signing key is available, so no verdict can authorize a write' };
  }

  if (!action?.contentHash) {
    // No revision to bind a verdict to means a replay would be undetectable, so
    // the one-shot guarantee does not exist for this action. Acting without it
    // would be acting on the one class of action the gate cannot protect.
    return { verdict: 'demote', reason: 'the action has no contentHash, so no gate verdict can be bound to a revision' };
  }

  const slot = gateKey(action);
  // One shot per slot: a verified, slot-bound entry (approve OR demote) refuses a
  // second review. Not bound to artifactDigest, so rewording cannot buy a re-roll.
  // An unverifiable or relocated entry is not a record of a review: overwrite it.
  if (verifyLedgerEntry(key, ledger?.[slot]) && entryBindsSlot(ledger[slot], action)) {
    return {
      verdict: 'demote',
      reason: `this revision was already gated (verdict: ${ledger[slot].verdict}); a second review of the same (issue, contentHash) is refused`,
    };
  }

  const record = (verdict, reason) => {
    ledger[slot] = sealLedgerEntry(key, {
      verdict,
      reason,
      reviewer: pair.reviewer,
      decider: pair.decider,
      contentHash: action.contentHash,
      number: action.number,
      action: action.action,
      field: action.field ?? null,
      artifactDigest: artifactDigest(action),
    });
    return { verdict, reason };
  };

  let code;
  try {
    const res = runReview();
    code = res?.code;
  } catch (err) {
    // A reviewer that could not run is not a reviewer that approved — AND the
    // attempt is spent. Returning without recording would leave the one-shot
    // rule unenforced for exactly the case a caller can manufacture at will: a
    // spawn failure or a timeout, retried until the reviewer finally answers.
    const reason = `the review could not complete: ${err?.message ?? err}`;
    return record('demote', reason);
  }

  const approved = code === REVIEW_APPROVE;
  const verdict = approved ? 'approve' : 'demote';
  const reason = approved
    ? null
    : code === REVIEW_NEEDS_ATTENTION
      ? 'the reviewer raised a material finding'
      : `the review could not complete (exit ${code})`;

  return record(verdict, reason);
}

/**
 * A filesystem-safe name for one action's artifact.
 *
 * DERIVED, never interpolated from caller data. `contentHash` reaches this from
 * a JSON file on disk, so a crafted value like `x/../../../etc/target` would
 * make `join` resolve outside the scratch directory and truncate whatever is
 * there. Hashing the pair gives a fixed-shape name with no separators and no
 * dots to walk.
 */
export function artifactName(action) {
  const digest = createHash('sha256').update(`${action?.number}:${action?.contentHash}`).digest('hex').slice(0, 32);
  return `action-${digest}.md`;
}

/**
 * The review artifact for ONE action.
 *
 * §3.6 requires one issue per artifact, and the reason is attribution rather
 * than size: a reviewer handed the whole groomed set returns one verdict for the
 * batch, and treating that as authorization for each action means an approve
 * never confirmed the specific write being executed. A batch containing one
 * unsafe close would license the unsafe close along with everything else.
 *
 * The artifact carries the revision it is bound to, so the verdict recorded
 * against `(issue, contentHash)` describes the same thing the reviewer read.
 */
export function buildActionArtifact(action) {
  return [
    `# Proposed ${action.action} — issue #${action.number}`,
    `- issue: #${action.number}`,
    `- action: ${action.action}`,
    `- revision (contentHash): ${action.contentHash}`,
    action.field ? `- field: ${action.field}` : '',
    action.from ? `- from: ${action.from}` : '',
    action.to ? `- to: ${action.to}` : '',
    '## Evidence',
    typeof action.evidence === 'string' ? action.evidence : JSON.stringify(action.evidence ?? null, null, 2),
    '## What is being asked',
    `Is this ${action.action} justified by the evidence above, for this issue, at this revision?`,
    'A material objection means the action is demoted to a proposal for a human.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
