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
//   We sign the deterministic JSON of an object containing ONLY the
//   chain-relevant fields, in this fixed key order:
//       { seq, gate, ts, ticket, data, files, prev }
//   built via canonicalEntryBytes() below. Optional fields (ticket, data) are
//   included only when present on the entry — matching how buildEntry omits
//   them — so the signed bytes mirror the entry's own shape. The `sig` field
//   itself is never part of the signed bytes.

import { createHmac, timingSafeEqual } from 'node:crypto';

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
 * Deterministic: fixed key order, optional fields included only when the entry
 * carries them. The `sig` field is always excluded.
 *
 * @param {object} entry  a manifest entry (with or without `sig`)
 * @returns {string} canonical JSON string
 */
export function canonicalEntryBytes(entry) {
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
