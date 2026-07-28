// sign.mjs — keyed signing for manifest entries (HMAC-SHA256, zero-dep).
//
// WHY: the hash chain (`prev` = sha256(previous raw line)) is keyless. Anyone
// who can write the ledger file can recompute every `prev` and forge a clean
// chain from scratch — sha256 is a public function with no secret. To make the
// chain a real *provenance* signal (in-toto/SLSA-style), each entry is signed
// with HMAC-SHA256 under a secret key (env ADLC_MANIFEST_KEY). An attacker
// without the key cannot produce a valid `sig`, so a forged chain fails verify.
//
// CANONICAL BYTES SIGNED — must be byte-identical on record and verify:
//   Legacy gate records use the fixed v1 field set. Generalized runner evidence
//   carries sigVersion:2 and signs canonical JSON for every field except `sig`,
//   so ticket/revision/provenance fields on the final ledger entry are covered.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@adlc/core';

/** Env var holding the secret signing key. */
export const KEY_ENV = 'ADLC_MANIFEST_KEY';

/**
 * Read the signing key from the environment.
 * Returns the key string, or null when unset/empty.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function getKey(env = process.env) {
  const k = env[KEY_ENV];
  return typeof k === 'string' && k.length > 0 ? k : null;
}

/**
 * Build the canonical byte string that gets signed for an entry.
 *
 * Deterministic: v1 uses the historical fixed key order; v2 recursively sorts
 * and signs every field carried by the entry. The `sig` field is always excluded.
 *
 * Also excludes `segment`: forest.mjs's readManifestForest annotates every
 * entry it returns with its source segment ('root' or a segment filename) —
 * metadata inferred from WHICH FILE a line was read from, never itself
 * written to disk as part of the entry. v2 signs "every field the entry
 * carries", so without this exclusion, ANY entry read via readManifestForest
 * would recompute different canonical bytes than what was actually signed at
 * write time, and EVERY signature would fail to verify — not a hypothetical:
 * this is exactly what happened first time a forest-read entry reached
 * verifyEntrySig (T-MANIFEST-FOREST slice 2, cross-model.mjs). `segment` is
 * therefore a reserved, read-only annotation field, the same category as
 * `sig` itself — never part of what gets signed.
 *
 * @param {object} entry  a manifest entry (with or without `sig`)
 * @returns {string} canonical JSON string
 */
export function canonicalEntryBytes(entry) {
  if (entry.sigVersion === 2) {
    const { sig: _sig, segment: _segment, ...signed } = entry;
    return canonicalJson(signed);
  }
  const canonical = {
    seq: entry.seq,
    gate: entry.gate,
    ts: entry.ts,
  };
  if (entry.ticket !== undefined) canonical.ticket = entry.ticket;
  if (entry.data !== undefined) canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return JSON.stringify(canonical);
}

/**
 * Compute the HMAC-SHA256 signature (hex) of an entry under a key.
 * @param {string} key
 * @param {object} entry
 * @returns {string} hex digest
 */
export function signEntry(key, entry) {
  return createHmac('sha256', key).update(canonicalEntryBytes(entry)).digest('hex');
}

/**
 * Constant-time check that `entry.sig` is the correct HMAC for `key`.
 * Returns false when sig is missing, malformed, or wrong.
 * @param {string} key
 * @param {object} entry
 * @returns {boolean}
 */
export function verifyEntrySig(key, entry) {
  if (typeof entry.sig !== 'string' || entry.sig.length === 0) return false;
  const expected = signEntry(key, entry);
  // Both are hex strings of equal length (sha256 → 64 hex chars) when sig is
  // well-formed; guard against length mismatch which timingSafeEqual rejects.
  const a = Buffer.from(entry.sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
