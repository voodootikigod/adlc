// Canonical JSON: object keys sorted at every depth, no whitespace. Hashes and
// size limits are computed over this form, so key order never changes either.
import { canonicalJson, sha256 } from '@adlc/core';

export { canonicalJson, sha256 };

/** sha256 hex digest of the canonical JSON of `value`. */
export function canonicalHash(value) {
  return sha256(canonicalJson(value));
}

/** Byte length of the canonical JSON of `value`, as UTF-8. */
export function canonicalBytes(value) {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}
