// cross-model.mjs — record and check a cross-model adversarial attestation (T39).
//
// The trust-root tier requires a cross-model adversarial `approve` from a provider
// DISTINCT from the author's, bound to the reviewed revision. We record it through
// gate-manifest's EXISTING chained record() (append-only, hash-linked, optionally
// HMAC-signed) rather than a bespoke writer, so the attestation is machine-checkable
// and shares the manifest's tamper-evidence. Mirrors build-gate/parallax/coldstart,
// which likewise call @adlc/gate-manifest's record() directly.
//
// HONESTY: like rails-guard this cannot cryptographically prove a model actually ran.
// It raises the bar to an auditable, revision-bound, append-only, distinct-provider
// record. Signing a provider assertion was rejected (see #104/T36 — keys in CI); the
// revision binding is what stops a stale attestation from clearing a fresh diff.

import { readEntries } from '@adlc/core';
import { record } from '@adlc/gate-manifest/lib/record.mjs';

export const CROSS_MODEL_GATE = 'cross-model-review';
const VALID_VERDICTS = new Set(['approve', 'needs-attention']);

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`cross-model review requires a non-empty ${field}`);
  }
  return value;
}

/**
 * Record a cross-model attestation. FAIL-CLOSED: throws if any field is missing,
 * the verdict is unknown, or provider === authorProvider (a same-model review is
 * NOT cross-model and must never be recordable as one).
 *
 * @returns the recorded manifest entry.
 */
export function recordCrossModelReview({ ticket, revision, provider, authorProvider, verdict, dir } = {}) {
  requireNonEmptyString(ticket, 'ticket');
  requireNonEmptyString(revision, 'revision');
  requireNonEmptyString(provider, 'provider');
  requireNonEmptyString(authorProvider, 'authorProvider');
  requireNonEmptyString(verdict, 'verdict');
  if (!VALID_VERDICTS.has(verdict)) {
    throw new Error(`cross-model review verdict must be one of ${[...VALID_VERDICTS].join(', ')}, got "${verdict}"`);
  }
  if (provider === authorProvider) {
    throw new Error('cross-model review requires a provider distinct from the author');
  }
  return record({
    gate: CROSS_MODEL_GATE,
    ticket,
    rawData: JSON.stringify({ provider, authorProvider, verdict, revision }),
    dir,
  });
}

/**
 * True iff the manifest holds a cross-model `approve` that satisfies the gate:
 * verdict === 'approve', bound to `revision`, for `ticket`, with a non-empty
 * provider distinct from a non-empty authorProvider. Anything else → false
 * (fail-closed). gate-manifest writes entries under `gate`; prosecute's own
 * evidence writer uses `type` — normalize both so either shape is honored.
 */
export function hasCrossModelApprove({ dir, ticket, revision } = {}) {
  if (!ticket || !revision) return false;
  const { entries } = readEntries('manifest', dir);
  return entries.some((entry) => {
    if ((entry.gate ?? entry.type) !== CROSS_MODEL_GATE) return false;
    if (entry.ticket !== ticket) return false;
    const data = entry.data;
    if (!data || typeof data !== 'object') return false;
    if (data.verdict !== 'approve') return false;
    if (data.revision !== revision) return false;
    const { provider, authorProvider } = data;
    if (typeof provider !== 'string' || provider.trim() === '') return false;
    if (typeof authorProvider !== 'string' || authorProvider.trim() === '') return false;
    if (provider === authorProvider) return false;
    return true;
  });
}
