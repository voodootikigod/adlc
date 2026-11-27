// attestation-store.mjs — protected-ref mirror closing the cross-model manifest
// TRUNCATION gap (#355, #354 F1 follow-up).
//
// #354 closed FORGERY (signatures cover the entry) and REWRITE (the hash chain +
// per-entry signature reject any edited-in-place line). The one gap left is
// TRUNCATION: an author who controls the PR branch can drop a signed
// `needs-attention` revocation entirely, leaving a valid, shorter, validly-signed
// chain that ends in an earlier genuine `approve`. Closing it needs memory of an
// attestation that lives OUTSIDE the attacker-controlled branch, recorded the
// moment a trusted CI run first observes it — that memory is this store.
//
// Pure and gate-agnostic: no git awareness, no knowledge of any specific gate
// name. Callers (the CLI, the cross-model gate) pass already-scoped entry arrays
// and a store file path; every function here only ever deals in HMAC-signed
// manifest entries and plain files.

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isEd25519PrivateKey, SIG_ALG_ED25519, verifyEntrySig } from '@adlc/gate-manifest/lib/sign.mjs';
import { changeSetDigest } from '@adlc/core';

// Round-5 cross-model review (codex): a present-but-invalid signature on a STORE
// entry must FAIL CLOSED, not be silently treated as absent. It means either a
// key rotation (every historical store entry needs migrating onto the new key)
// or tampering by whoever has bypass-level write access to the store's protected
// branch. Silently filtering it out would let a truncated revocation go undetected
// (the exact attack this store exists to close) and would let a stale-but-present
// `sig` block a valid re-append via mirror's dedup, permanently masking the
// corruption. When neither `key` nor `publicKey` is present, verification is
// skipped (matching "no verifier -> nothing is trusted").
function readStoreEntries(storePath, { key = null, publicKey = null } = {}) {
  if (!existsSync(storePath)) return [];
  const content = readFileSync(storePath, 'utf8');
  const entries = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    entries.push(JSON.parse(line));
  }
  const hasHmacKey = typeof key === 'string' && key.length > 0 && !isEd25519PrivateKey(key);
  const hasEd25519Verifier = (typeof publicKey === 'string' && publicKey.length > 0) || isEd25519PrivateKey(key);
  if (hasHmacKey || hasEd25519Verifier) {
    for (const entry of entries) {
      if (entry?.sigAlg === SIG_ALG_ED25519) {
        if (!verifyEntrySig(key, entry, { publicKey })) {
          throw new Error(
            `attestation store at ${storePath} contains an Ed25519 entry (seq=${entry?.seq ?? '?'}) whose signature does not verify under the trusted public key (or no Ed25519 public key was provided) — refusing to silently treat it as absent.`
          );
        }
      } else if (entry?.sigAlg !== undefined) {
        throw new Error(
          `attestation store at ${storePath} contains an entry (seq=${entry?.seq ?? '?'}) with unsupported sigAlg "${entry.sigAlg}" — refusing to silently treat it as absent.`
        );
      } else if (hasHmacKey) {
        if (!verifyEntrySig(key, entry, { publicKey })) {
          throw new Error(
            `attestation store at ${storePath} contains an entry (seq=${entry?.seq ?? '?'}) whose signature does not verify under the given key — this is either an ADLC_MANIFEST_KEY rotation (every historical store entry needs migrating onto the new key) or tampering. Refusing to silently treat it as absent: migrate or rebootstrap the store rather than ignoring this.`
          );
        }
      }
    }
  }
  return entries;
}

function verifiedSig(key, entry, publicKey = null) {
  return typeof entry?.sig === 'string' && entry.sig.length > 0 && (Boolean(key) || Boolean(publicKey)) && verifyEntrySig(key, entry, { publicKey });
}

/**
 * Read the store's entries, FAILING CLOSED (throwing) if any entry's signature
 * does not verify under `key` / `publicKey` — see the fail-closed rationale above
 * `readStoreEntries`. A missing file is the bootstrap case (first trusted run
 * ever) and returns an empty list without throwing. Without either a key or a
 * publicKey nothing can be verified, so nothing is trusted and this returns an
 * empty list.
 *
 * @param {string} storePath  direct path to the attestations.jsonl FILE.
 * @param {{ key?: string|null, publicKey?: string|null }} [opts]
 * @returns {object[]}
 */
export function readObservedAttestations(storePath, { key = null, publicKey = null } = {}) {
  if (!key && !publicKey) return [];
  return readStoreEntries(storePath, { key, publicKey });
}

/**
 * Pure; never throws. For `revision`, every OBSERVED entry's signature must be
 * present among the PR's currently valid (signature-verified) entries for that
 * same revision — a dropped signed entry (truncation) fails closed and is named.
 *
 * Revision is itself signature-covered (`canonicalEntryBytes` signs `data`,
 * which includes `revision`), so an attacker cannot relabel a dropped entry's
 * revision to dodge this check: any alteration invalidates its signature.
 *
 * @returns {{ ok: true } | { ok: false, missing: string[] }}
 */
export function assertNoTruncation({ prEntries, observedEntries, revision, key = null, publicKey = null, ticket }) {
  const matchesTicket = (entry) => ticket === undefined || entry?.ticket === ticket;
  const scopedPrEntries = prEntries.filter((entry) => matchesTicket(entry) && verifiedSig(key, entry, publicKey));
  const scopedObserved = observedEntries.filter((entry) => matchesTicket(entry) && verifiedSig(key, entry, publicKey));
  const relevantRevisions = new Set([revision]);
  // Walk carriedFrom iteratively (fixpoint) so every ancestor revision of `revision`
  // is covered, whether the link lives in the PR manifest or the observed store.
  const linkSources = [...scopedPrEntries, ...scopedObserved];
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of linkSources) {
      const from = entry?.data?.carriedFrom;
      if (typeof from === 'string' && relevantRevisions.has(entry?.data?.revision) && !relevantRevisions.has(from)) {
        relevantRevisions.add(from);
        grew = true;
      }
    }
  }
  const digest = changeSetDigest(revision);
  const observedRelevant = scopedObserved.filter((entry) => {
    if (relevantRevisions.has(entry?.data?.revision)) return true;
    return Boolean(digest) &&
      entry?.data?.verdict === 'needs-attention' &&
      changeSetDigest(entry?.data?.revision) === digest;
  });
  const prSigs = new Set(scopedPrEntries.map((entry) => entry.sig));
  const missing = observedRelevant.map((entry) => entry.sig).filter((sig) => !prSigs.has(sig));
  return missing.length > 0 ? { ok: false, missing } : { ok: true };
}

/**
 * Append every valid (signature-verified) entry from `prEntries` not already
 * present in the store, deduped by the entry's own `sig` (two entries with the
 * same `sig` are byte-identical by construction — the signature covers the full
 * canonical entry). Bootstraps the store file and any missing parent
 * directories. Returns the count newly appended.
 *
 * FAILS CLOSED (throws) if the EXISTING store already contains a tampered entry
 * — same rationale as `readObservedAttestations`. Refusing to mirror onto a
 * known-corrupted store, rather than silently continuing, matters specifically
 * here: a stale-but-present `sig` on a tampered line would otherwise block a
 * valid re-append forever via the dedup check below, masking the corruption
 * instead of surfacing it for repair.
 *
 * @returns {number}
 */
export function mirrorObservedAttestations({ prEntries, storePath, key = null, publicKey = null }) {
  const existingEntries = readStoreEntries(storePath, { key, publicKey });
  const existingSigs = new Set(existingEntries.map((entry) => entry.sig));
  const toAppend = prEntries.filter((entry) => verifiedSig(key, entry, publicKey) && !existingSigs.has(entry.sig));
  if (toAppend.length === 0) return 0;
  mkdirSync(dirname(storePath), { recursive: true });
  appendFileSync(storePath, toAppend.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  return toAppend.length;
}
