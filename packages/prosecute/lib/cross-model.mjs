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
import { verify } from '@adlc/gate-manifest/lib/verify.mjs';

export const CROSS_MODEL_GATE = 'cross-model-review';
const VALID_VERDICTS = new Set(['approve', 'needs-attention']);

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`cross-model review requires a non-empty ${field}`);
  }
  return value;
}

// Provider identity is compared normalized everywhere, so a same actual provider
// cannot fake distinctness with a low-effort variant: NFKC-fold, strip ALL
// whitespace, and case-fold ("openai " / "OpenAI" / "open ai" / fullwidth forms
// all collapse to "openai"). Raw strings are still STORED for audit fidelity;
// only the distinctness DECISION uses the normalized form.
//
// DOCUMENTED HONEST LIMIT (see the file header + ADR-0007): this is an
// honest-party attestation, not cryptographic proof. Normalization defeats
// accidental and low-effort variants, but it CANNOT defeat a determined forger
// who deliberately spells their own provider as a cross-script homoglyph
// ("οpenai") or a semantic alias ("gpt" vs "openai") — that is the same threat
// class as lying about --author-provider outright, which the gate concedes it
// cannot stop. The gate's value is the auditable, revision-bound record, not
// unforgeable identity.
function normalizeProvider(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
    : '';
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
  if (normalizeProvider(provider) === normalizeProvider(authorProvider)) {
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
 * True iff the manifest holds a cross-model `approve` that satisfies the gate.
 *
 * CRITICAL author-anchoring: the caller passes `authorProvider` from the
 * PROSECUTION run (CLI `--author-provider` / `ADLC_AUTHOR_PROVIDER`), NOT from the
 * attestation. An attestation defines both `provider` and `authorProvider`, so if
 * we only compared the entry's two self-reported fields a same-provider author
 * could just record `provider:"claude", authorProvider:"openai"` and pass. Instead
 * the reviewer's `provider` must differ from the PROSECUTION-declared author, and
 * the attestation must have been recorded FOR that author context
 * (`entry.data.authorProvider === authorProvider`). We keep the entry's own
 * `provider !== authorProvider` check too (belt and suspenders on the write side).
 *
 * Everything else fails closed. gate-manifest writes entries under `gate`;
 * prosecute's own evidence writer uses `type` — normalize both.
 */
// Shared per-entry predicate. `ticket` is OPTIONAL: the per-ticket runner gate
// (hasCrossModelApprove) requires it; the CI tier gate (#326,
// hasCrossModelApproveForRevision) omits it and binds to the REVISION only — a
// trust-root change (e.g. an enforcement-package edit) need not map to one ticket,
// and the revision hash is the anti-stale anchor that stops a prior attestation
// from clearing a fresh diff.
// A candidate cross-model review entry for (revision, author, [ticket]) from a
// DISTINCT reviewer. Returns { provider, verdict } for a valid approve/needs-
// attention entry, or null. `ticket` optional (the revision gate omits it).
function candidateReview(entry, { ticket, revision, runAuthor }) {
  if ((entry.gate ?? entry.type) !== CROSS_MODEL_GATE) return null;
  if (ticket !== undefined && entry.ticket !== ticket) return null;
  const data = entry.data;
  if (!data || typeof data !== 'object') return null;
  if (data.revision !== revision) return null;
  if (data.verdict !== 'approve' && data.verdict !== 'needs-attention') return null;
  const provider = normalizeProvider(data.provider);
  const entryAuthor = normalizeProvider(data.authorProvider);
  if (provider === '' || entryAuthor === '' || runAuthor === '') return null;
  // Write-side belt-and-suspenders: the attestation must not be same-provider.
  if (provider === entryAuthor) return null;
  // Author anchored to the run: the reviewer must differ from the real
  // (run-declared) author, and the record must be for THIS author. All compared
  // normalized so a whitespace/case variant cannot fake distinctness.
  if (provider === runAuthor) return null;
  if (entryAuthor !== runAuthor) return null;
  return { provider, verdict: data.verdict };
}

// The gate is satisfied iff some distinct-provider reviewer's LATEST verdict for
// this revision is `approve`. Entries are chronological (append-only manifest), so
// the last entry per provider wins — a later `needs-attention` REVOKES an earlier
// `approve` from that provider (#326 P5 finding), while a different provider's
// standing approve still counts.
function crossModelSatisfied(entries, match) {
  const latestByProvider = new Map();
  for (const entry of entries) {
    const review = candidateReview(entry, match);
    if (review) latestByProvider.set(review.provider, review.verdict);
  }
  for (const verdict of latestByProvider.values()) if (verdict === 'approve') return true;
  return false;
}

// FAIL CLOSED on a manifest whose hash chain does not verify (#326 Codex F2). Before
// trusting ANY approve, walk the chain: readEntries() silently shunts a malformed or
// truncated line into `skipped`, so an attacker could garble a later `needs-attention`
// line — WITHOUT re-chaining, the cheap attack — and the dropped revocation would let
// the earlier `approve` resurface. verify() returns valid:false at the first break, so
// a corrupt/truncated manifest can no longer clear the gate. (Re-authoring the tail so
// it re-chains cleanly is the documented honest-limit — defeated only by
// ADLC_MANIFEST_KEY; this closes the cheap corrupt-and-skip path, not that one.)
function manifestChainTrustworthy(dir) {
  return verify(dir).valid === true;
}

export function hasCrossModelApprove({ dir, ticket, revision, authorProvider } = {}) {
  if (!ticket || !revision || !authorProvider) return false;
  if (!manifestChainTrustworthy(dir)) return false;
  const { entries } = readEntries('manifest', dir);
  return crossModelSatisfied(entries, { ticket, revision, runAuthor: normalizeProvider(authorProvider) });
}

/**
 * True iff the manifest holds a distinct-provider cross-model `approve` bound to
 * `revision`, recorded for author `authorProvider` — REGARDLESS of ticket. The CI
 * trust-root-tier gate (#326) uses this: it verifies the reviewed revision was
 * cross-model approved without requiring the change to name a single ticket.
 */
export function hasCrossModelApproveForRevision({ dir, revision, authorProvider } = {}) {
  if (!revision || !authorProvider) return false;
  if (!manifestChainTrustworthy(dir)) return false;
  const { entries } = readEntries('manifest', dir);
  return crossModelSatisfied(entries, { ticket: undefined, revision, runAuthor: normalizeProvider(authorProvider) });
}
