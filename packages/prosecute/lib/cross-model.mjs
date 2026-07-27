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
// record. What it CAN prove is that the record was minted by a holder of the CI-only
// ADLC_MANIFEST_KEY: attestations are HMAC-signed (see sign.mjs) and the read side
// rejects any unsigned or wrong-key entry, so a PR author cannot forge an approve. The
// revision binding stops a stale attestation from clearing a fresh diff. (The earlier
// "keys in CI" objection, #104/T36, is resolved by the trusted-context gate in
// cross-model-gate.yml, which lets the key verify signatures without ever exposing it
// to PR-controlled code.)

import { readEntries } from '@adlc/core';
import { record } from '@adlc/gate-manifest/lib/record.mjs';
// Two independent defenses on the read side: verify() proves the append-only chain
// was not corrupted-and-skipped to drop a revocation (#326 Codex F2); verifyEntrySig()
// proves each attestation was signed with the CI-only key, so a PR author cannot FORGE
// a fresh, well-chained approve. The chain check alone left that forge open by design.
import { verify } from '@adlc/gate-manifest/lib/verify.mjs';
import { getKey, verifyEntrySig } from '@adlc/gate-manifest/lib/sign.mjs';

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
function candidateReview(entry, { ticket, revision, runAuthor, key }) {
  if ((entry.gate ?? entry.type) !== CROSS_MODEL_GATE) return null;
  // #326 hardening — verify the HMAC signature FIRST. The manifest lives in the
  // contributor-controlled PR tree, so matching self-reported data fields alone lets a
  // PR author FORGE an approve. The attestation is trusted ONLY if it carries a valid
  // signature under the key (a CI secret the PR author does not hold). An unsigned,
  // mis-signed, or wrong-key entry is not a candidate — fail closed.
  if (!key || !verifyEntrySig(key, entry)) return null;
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
// the earlier `approve` resurface. A garbled line breaks the hash linkage, so verify()
// returns valid:false and a corrupt/truncated manifest can no longer clear the gate.
//
// requireSignatures:false — tolerate UNSIGNED history, still reject TAMPERED signatures.
// The shared manifest accumulates entries from other gates, most recorded before signing
// was enabled, so they are legitimately unsigned. A full sig-requiring verify() with the
// key present would fail on the FIRST such entry and make this gate permanently inert (no
// PR could ever pass). So we do not DEMAND every entry be signed — but a present-but-
// invalid sig is still rejected, so an attacker cannot rewrite a signed `needs-attention`
// revocation (invalidating its sig) and slip it past as "chain-only". Per-entry FORGE
// resistance is enforced where it matters: candidateReview verifyEntrySig()s the specific
// approve it is about to trust, so a fabricated (unsigned / wrong-key) approve is rejected.
//
// HONEST LIMIT (Codex #354 F1, truncation) — NOT closed by this PR. A hash chain has no
// authenticated head, so an author who controls the PR branch can DROP a signed revocation
// recorded on that branch (truncate the manifest to end at an earlier, still-valid signed
// approve). Rewriting a revocation is closed (its now-invalid sig is rejected above); DROPPING
// one is not. Making this gate a required check does NOT close it either: the required check
// evaluates the attacker's truncated tree, finds a valid chain ending in the approve, and
// passes. Because the dropped revocation is a PR-branch entry, base-anchoring cannot see it,
// so closing this needs the LATEST state anchored OUTSIDE the PR-controlled tree — attestations
// (or a per-PR high-water mark) written by the trusted workflow to a store the author cannot
// rewrite (a protected branch/ref, a check-run, or an external signed checkpoint). That is a
// storage-location change, deliberately left as follow-up; see the PR discussion.
function manifestChainTrustworthy(dir) {
  return verify(dir, { requireSignatures: false }).valid === true;
}

export function hasCrossModelApprove({ dir, ticket, revision, authorProvider, key = getKey() } = {}) {
  // No key → the reader cannot verify any attestation's signature → nothing is trusted.
  if (!ticket || !revision || !authorProvider || !key) return false;
  if (!manifestChainTrustworthy(dir)) return false;
  const { entries } = readEntries('manifest', dir);
  return crossModelSatisfied(entries, { ticket, revision, runAuthor: normalizeProvider(authorProvider), key });
}

/**
 * True iff the manifest holds a distinct-provider cross-model `approve` bound to
 * `revision`, recorded for author `authorProvider` — REGARDLESS of ticket. The CI
 * trust-root-tier gate (#326) uses this: it verifies the reviewed revision was
 * cross-model approved without requiring the change to name a single ticket.
 */
export function hasCrossModelApproveForRevision({ dir, revision, authorProvider, key = getKey() } = {}) {
  // No key → cannot verify a signature → fail closed (an unverifiable attestation is a
  // forgeable one; the CI gate must not trust the PR-controlled manifest without the key).
  // Only the key is fast-checked here: a missing/empty `revision` or `authorProvider` is
  // already fail-closed per-entry by candidateReview (an undefined revision matches no
  // entry's `data.revision`; an empty runAuthor is rejected), so guarding them here too
  // would be redundant and unverifiable — candidateReview is the single enforcement point.
  if (!key) return false;
  if (!manifestChainTrustworthy(dir)) return false;
  const { entries } = readEntries('manifest', dir);
  return crossModelSatisfied(entries, { ticket: undefined, revision, runAuthor: normalizeProvider(authorProvider), key });
}
