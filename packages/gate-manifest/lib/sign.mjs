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
//   canonicalEntryBytes is single-sourced from @adlc/tickets/lib/manifest-primitives.mjs.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalEntryBytes } from '@adlc/tickets/lib/manifest-primitives.mjs';

export { canonicalEntryBytes };

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
