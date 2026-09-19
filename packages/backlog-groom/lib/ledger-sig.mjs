/**
 * Signing for the gate ledger (#1035).
 *
 * The ledger is the ONLY source of authorization on the apply path — `planAction`
 * refuses anything it does not approve, precisely so a caller-supplied `gate`
 * field cannot authorize itself. But every field the approval check looked at was
 * one the caller could compute (`artifactDigest` is exported and pure), so writing
 * one JSON object into `.adlc/backlog-groom-ledger.json` bought a comment and a
 * close with no reviewer ever having run. An HMAC the caller cannot forge is what
 * makes the record mean something.
 *
 * NOT `@adlc/gate-manifest`'s `sign.mjs`, deliberately. That package's `exports`
 * map is root-only and re-exports one function, so reaching its signing helpers
 * would mean widening the public surface of an ENFORCEMENT_PREFIXES package —
 * making every future ledger change a trust-root change, with the signing
 * ceremony that implies. The primitive is three lines of `node:crypto`; the
 * coupling would be permanent.
 *
 * DOMAIN-SEPARATED for the same reason the ticket store and the active store use
 * distinct domain prefixes: a signature over one kind of record must never verify
 * as a signature over another, whatever the field names happen to be.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Prefix bound into every ledger signature. Changing it invalidates them all. */
export const LEDGER_SIG_DOMAIN = 'adlc:backlog-groom-ledger:v1\0';

/**
 * Deterministic JSON: object keys sorted, recursively.
 *
 * `JSON.stringify` preserves insertion order, so the same entry written by two
 * code paths could canonicalise differently and fail to verify. Sorting makes the
 * bytes a function of the CONTENT alone.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * The bytes a signature covers: the whole entry except `sig` itself.
 *
 * EVERY other field, rather than a named list: a list is a standing invitation to
 * add a field that authorizes something and forget to sign it. `applied` is the
 * concrete case — it makes `executeActions` skip the write and report the action
 * as already done, so an unsigned `applied` would let a caller have the tool
 * announce a close it never performed.
 */
export function ledgerEntryBytes(entry) {
  const { sig: _sig, ...signed } = entry ?? {};
  return `${LEDGER_SIG_DOMAIN}${canonicalJson(signed)}`;
}

/** The HMAC-SHA256 of one entry under `key`, hex. */
export function signLedgerEntry(key, entry) {
  return createHmac('sha256', key).update(ledgerEntryBytes(entry)).digest('hex');
}

/**
 * Is `entry.sig` the correct signature for `entry` under `key`?
 *
 * Returns false — never throws — for a missing key, a missing or malformed `sig`,
 * a non-object entry, or a wrong signature. A verifier that throws on malformed
 * input is a verifier a crafted ledger can turn into a crash, and a crash on the
 * authorization path is not a refusal anyone reads.
 */
export function verifyLedgerEntry(key, entry) {
  if (typeof key !== 'string' || key.length === 0) return false;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (typeof entry.sig !== 'string' || entry.sig.length === 0) return false;

  const expected = signLedgerEntry(key, entry);
  const actual = Buffer.from(entry.sig, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, and a wrong-length sig is simply
  // wrong — compare lengths first, then the bytes in constant time.
  if (actual.length !== wanted.length) return false;
  return timingSafeEqual(actual, wanted);
}

/**
 * Return a copy of `entry` carrying a signature for its current content.
 *
 * Every mutation of a ledger entry goes through this. An entry whose content
 * changed after signing does not verify, which is the point — but it means a
 * write that forgets to re-sign silently invalidates a legitimate approval, so
 * this returns the signed object rather than leaving the caller to remember.
 */
export function sealLedgerEntry(key, entry) {
  const { sig: _sig, ...content } = entry ?? {};
  return { ...content, sig: signLedgerEntry(key, content) };
}
