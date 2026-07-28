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
import { verifyEntrySig } from '@adlc/gate-manifest/lib/sign.mjs';

// Round-5 cross-model review (codex): a present-but-invalid signature on a STORE
// entry must FAIL CLOSED, not be silently treated as absent. It means either an
// ADLC_MANIFEST_KEY rotation (every historical store entry needs migrating onto
// the new key — the same treatment this repo already gives the main manifest
// chain, see the #364 tests/gate-manifest docs) or tampering by whoever has
// bypass-level write access to the store's protected branch. Silently filtering
// it out would let a truncated revocation go undetected (the exact attack this
// store exists to close) and would let a stale-but-present `sig` block a valid
// re-append via mirror's dedup, permanently masking the corruption. `key`
// absent skips verification entirely (nothing CAN be verified without it,
// matching this codebase's "no key -> nothing is trusted" convention elsewhere
// — that is a different, deliberate case from "key present, one entry doesn't
// match it").
function readStoreEntries(storePath, key) {
  if (!existsSync(storePath)) return [];
  const content = readFileSync(storePath, 'utf8');
  const entries = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    entries.push(JSON.parse(line));
  }
  if (key) {
    for (const entry of entries) {
      if (!verifyEntrySig(key, entry)) {
        throw new Error(
          `attestation store at ${storePath} contains an entry (seq=${entry?.seq ?? '?'}) whose signature does not verify under the given key — this is either an ADLC_MANIFEST_KEY rotation (every historical store entry needs migrating onto the new key) or tampering. Refusing to silently treat it as absent: migrate or rebootstrap the store rather than ignoring this.`
        );
      }
    }
  }
  return entries;
}

function verifiedSig(key, entry) {
  return typeof entry?.sig === 'string' && Boolean(key) && verifyEntrySig(key, entry);
}

/**
 * Read the store's entries, FAILING CLOSED (throwing) if any entry's signature
 * does not verify under `key` — see the fail-closed rationale above
 * `readStoreEntries`. A missing file is the bootstrap case (first trusted run
 * ever) and returns an empty list without throwing. Without a key nothing can be
 * verified, so nothing is trusted and this returns an empty list — matches the
 * rest of this codebase's "no key -> nothing is trusted" convention.
 *
 * @param {string} storePath  direct path to the attestations.jsonl FILE.
 * @param {{ key?: string|null }} [opts]
 * @returns {object[]}
 */
export function readObservedAttestations(storePath, { key } = {}) {
  if (!key) return [];
  return readStoreEntries(storePath, key);
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
export function assertNoTruncation({ prEntries, observedEntries, revision, key }) {
  const observedForRevision = observedEntries.filter((entry) => entry?.data?.revision === revision);
  const prSigsForRevision = new Set(
    prEntries
      .filter((entry) => entry?.data?.revision === revision && verifiedSig(key, entry))
      .map((entry) => entry.sig)
  );
  const missing = observedForRevision.map((entry) => entry.sig).filter((sig) => !prSigsForRevision.has(sig));
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
export function mirrorObservedAttestations({ prEntries, storePath, key }) {
  const existingEntries = readStoreEntries(storePath, key);
  const existingSigs = new Set(existingEntries.map((entry) => entry.sig));
  const toAppend = prEntries.filter((entry) => verifiedSig(key, entry) && !existingSigs.has(entry.sig));
  if (toAppend.length === 0) return 0;
  mkdirSync(dirname(storePath), { recursive: true });
  appendFileSync(storePath, toAppend.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  return toAppend.length;
}
