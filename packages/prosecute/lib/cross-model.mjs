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

import { readEntries, isChangeSetRevision, changeSetBase, changeSetDigest } from '@adlc/core';
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

// ── Carry-forward (#365 B) ───────────────────────────────────────────────────
// An attestation binds to `(base_sha, change_set_hash)`, which is sound but means every advance
// of `main` invalidates a verdict for a change that has not moved. Performed by hand on #362 and
// #367, each time costing a full confirmatory review round to re-approve an identical diff.
//
// The danger, and why this is CAPPED (premortem F1): a diff can be byte-identical and
// semantically WRONG against a new base — main renames a helper it calls, or tightens a validator
// it relies on. The bytes do not move; the meaning does. Free carry-forward would let a verdict
// ride over bases nobody examined, which is WORSE than the treadmill it replaces: the treadmill
// at least forced a fresh look. So the chain is bounded and its depth is recorded, making an
// Nth-hand verdict visible in the ledger rather than indistinguishable from a fresh one.
export const CARRY_FORWARD_MAX_DEPTH = 3;

// The most recent cross-model entry for `ticket`, regardless of revision, or null.
//
// Deliberately NOT filtered by revision — see the caller. Looking up "the entry matching
// fromRevision" instead (as an earlier version did) lets the CALLER pick which entry counts as
// prior: a caller can name an OLD entry in the same ticket's history (e.g. the very first,
// un-carried approval) instead of the chain's actual current head, and since depth is read off
// whatever `prior` happens to be, that resets the accumulated depth to 1 and defeats
// CARRY_FORWARD_MAX_DEPTH — a verdict rides forward indefinitely without ever forcing the fresh
// review the cap exists to require (adversarial-review finding, #365). Finding the ticket's TRUE
// latest entry and requiring the caller's `fromRevision` to match it closes that: carrying
// forward from anything but the actual chain head is refused outright.
function latestEntryForTicket(entries, ticket) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if ((entry.gate ?? entry.type) !== CROSS_MODEL_GATE) continue;
    if (entry.ticket !== ticket) continue;
    return entry;
  }
  return null;
}

/**
 * Re-attest an EXISTING verdict against a new base, when the reviewed change is unchanged.
 *
 * Refuses unless every one of these holds:
 *   - a prior cross-model entry exists for `fromRevision` UNDER THE SAME `ticket` and its verdict
 *     is `approve` — scoped by ticket so a different ticket's approval at the same revision
 *     string can never be carried forward as this ticket's own;
 *   - both identities are change-set form (a legacy whole-worktree identity carries no change-set
 *     component, so "did the change move?" is not answerable about it);
 *   - the change-set digests are EQUAL — COMPUTED from the two identities, never asserted by the
 *     caller (F1/AC10). Both identities are produced by the gate, so equality here means the
 *     reviewed change genuinely did not move;
 *   - the resulting chain depth stays within CARRY_FORWARD_MAX_DEPTH.
 *
 * The carried entry inherits the ORIGINAL provider and authorProvider: it is the same verdict,
 * not a new one, and distinctness was already proven when it was first earned.
 *
 * SECURITY (adversarial-review finding, #365): the prior entry is PR-controlled data — the
 * manifest lives in the tree being reviewed — so it must clear the SAME two defenses the
 * read-side gate (candidateReview / hasCrossModelApprove) already requires before this function
 * trusts it: the hash chain must verify (manifestChainTrustworthy, so a corrupted-and-dropped
 * revocation for this exact ticket+revision cannot resurface an earlier approve), and the prior
 * entry itself must carry a valid signature (verifyEntrySig) under the key. Without both checks,
 * an attacker appends an UNSIGNED, forged "approve" to the manifest naming a real ticket and
 * revision; carry-forward would find it structurally plausible and mint a BRAND NEW, VALIDLY
 * SIGNED entry carrying it forward — laundering a forged claim into a real attestation through
 * whoever holds the signing key.
 */
export function carryForwardCrossModelReview({ ticket, fromRevision, revision, dir, key = getKey() } = {}) {
  requireNonEmptyString(ticket, 'ticket');
  requireNonEmptyString(fromRevision, 'fromRevision');
  requireNonEmptyString(revision, 'revision');

  if (!isChangeSetRevision(fromRevision) || !isChangeSetRevision(revision)) {
    throw new Error(
      'carry-forward requires change-set identities on both sides (git-change:<base>:<digest>); ' +
      'a legacy git-worktree identity has no change-set component, so whether the reviewed change ' +
      'moved cannot be determined — record a fresh review instead'
    );
  }
  if (changeSetDigest(fromRevision) !== changeSetDigest(revision)) {
    throw new Error(
      'carry-forward refused: the reviewed change itself differs between the two identities ' +
      '(change-set digests do not match). Only a base change may be carried forward — record a ' +
      'fresh distinct-provider review'
    );
  }
  if (changeSetBase(fromRevision) === changeSetBase(revision)) {
    throw new Error('carry-forward refused: the base is unchanged, so there is nothing to carry');
  }

  // No key -> nothing can be signature-verified -> fail closed, matching hasCrossModelApprove.
  if (!key) {
    throw new Error('carry-forward refused: no signing key available, so the prior entry cannot be signature-verified');
  }
  if (!manifestChainTrustworthy(dir)) {
    throw new Error('carry-forward refused: the manifest hash chain does not verify — a broken chain could be hiding a dropped revocation');
  }
  const { entries } = readEntries('manifest', dir);
  const prior = latestEntryForTicket(entries, ticket);
  if (!prior) {
    throw new Error(`carry-forward refused: no prior cross-model verdict recorded for ${fromRevision} under ticket ${ticket}`);
  }
  // fromRevision must name the ACTUAL head of the ticket's chain, not merely SOME earlier entry
  // in its history — otherwise a caller picks an old, low-depth entry to reset the depth cap.
  if (prior.data?.revision !== fromRevision) {
    throw new Error(
      `carry-forward refused: fromRevision (${fromRevision}) is not the latest recorded cross-model ` +
      `entry for ticket ${ticket} (latest is ${prior.data?.revision}) — carrying forward from a ` +
      'stale entry could skip an intervening revocation or reset the depth cap; carry forward from ' +
      'the actual latest entry, or record a fresh distinct-provider review'
    );
  }
  if (!verifyEntrySig(key, prior)) {
    throw new Error(
      `carry-forward refused: the prior entry for ${fromRevision} under ticket ${ticket} is not signature-verified ` +
      '— an unsigned or forged entry cannot be carried forward into a newly signed one'
    );
  }
  if (prior.data?.verdict !== 'approve') {
    throw new Error(
      `carry-forward refused: the prior verdict for ${fromRevision} is ` +
      `"${prior.data?.verdict}", not approve — only an approve can be carried`
    );
  }

  // Consecutive carries only: a fresh review resets the chain, because a human (or a distinct
  // model) looked at the change against that base.
  const depth = (Number(prior.data?.carryDepth) || 0) + 1;
  if (depth > CARRY_FORWARD_MAX_DEPTH) {
    throw new Error(
      `carry-forward refused: chain depth ${depth} exceeds the cap of ${CARRY_FORWARD_MAX_DEPTH}. ` +
      'The verdict has ridden forward across too many bases without anyone looking at it against ' +
      'the current one — record a FRESH distinct-provider review'
    );
  }

  return record({
    gate: CROSS_MODEL_GATE,
    ticket,
    rawData: JSON.stringify({
      provider: prior.data.provider,
      authorProvider: prior.data.authorProvider,
      verdict: 'approve',
      revision,
      carriedFrom: fromRevision,
      carryDepth: depth,
    }),
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
// requireSignatures:false — tolerate an UNSIGNED LEGACY PREFIX, still reject TAMPERED
// signatures. The shared manifest's early history predates signing, so those entries are
// legitimately unsigned. A full sig-requiring verify() with the key present would fail on
// the FIRST such entry and make this gate permanently inert (no PR could ever pass). So we
// do not DEMAND every entry be signed — but (as of #378) this tolerance is SCOPED to the
// contiguous prefix before the first signed entry in the file: a missing sig on any entry
// AFTER that point now breaks the chain here too, same as it does for the CLI's
// --allow-legacy-unsigned path (see verify.mjs). That is a deliberate STRENGTHENING versus
// the old unscoped tolerance, not a new risk — it fails this predicate closed on a ledger
// where signing appears to have lapsed after adoption (e.g. an append ran without the key),
// consistent with "FAIL CLOSED" above. A present-but-invalid sig is still rejected anywhere,
// so an attacker cannot rewrite a signed `needs-attention` revocation (invalidating its sig)
// and slip it past as "chain-only". Per-entry FORGE resistance is enforced where it matters
// regardless: candidateReview verifyEntrySig()s the specific approve it is about to trust,
// so a fabricated (unsigned / wrong-key) approve is rejected even if this predicate alone
// would have let a differently-shaped chain through.
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
// EXPORTED (#364) so a caller can tell WHY the gate failed. hasCrossModelApproveForRevision
// returns a bare boolean and checks this BEFORE examining any entry, so a broken chain and a
// genuinely absent attestation are indistinguishable to it — and the CLI reported both as
// "NO SIGNATURE-VERIFIED attestation", sending the operator to record one. That costs a full
// adversarial review before record-cross-model finally names the real cause. Exposing the
// predicate lets the CLI attribute the failure correctly; it changes no decision, and the
// gating call below is unchanged, so nothing here relaxes what is enforced.
export function manifestChainTrustworthy(dir) {
  return verify(dir, { requireSignatures: false }).valid === true;
}

// #378 — since manifestChainTrustworthy's requireSignatures:false is now scoped
// (see verify.mjs), "the chain does not verify" has TWO distinct causes: a
// present-but-invalid signature (classic key rotation) OR an unsigned entry
// appearing after signing was already adopted (signing lapsed post-adoption —
// a NEW failure mode this predicate can report, that unscoped tolerance never
// could). Callers that attribute the failure to the operator (e.g. tier-check's
// diagnostic) need to tell these apart rather than always blaming rotation.
export function manifestChainBreakReason(dir) {
  return verify(dir, { requireSignatures: false }).break?.reason ?? null;
}

export function hasCrossModelApprove({ dir, ticket, revision, authorProvider, key = getKey() } = {}) {
  // No key → the reader cannot verify any attestation's signature → nothing is trusted.
  if (!ticket || !revision || !authorProvider || !key) return false;
  if (!manifestChainTrustworthy(dir)) return false;
  // manifestChainTrustworthy already validates the WHOLE forest (root + any
  // segments) via the forest-aware verify() — a tampered or malformed segment
  // fails closed here even though this function only reads root entries below.
  // Deliberately root-only for now (T-MANIFEST-FOREST slice 1): walking
  // segment-recorded approvals needs the terminal-revocation redesign this
  // ticket's slice 2 does (spec §6 — "no entry anywhere in the forest" is a
  // stricter rule than today's "latest per provider", not a drop-in swap).
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
  // See hasCrossModelApprove above: root-only is deliberate here too, pending
  // slice 2's terminal-revocation redesign.
  const { entries } = readEntries('manifest', dir);
  return crossModelSatisfied(entries, { ticket: undefined, revision, runAuthor: normalizeProvider(authorProvider), key });
}
