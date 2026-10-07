// Canonical JSON: object keys sorted at every depth, no whitespace. Hashes and
// size limits are computed over this form, so key order never changes either.
import { createHash } from 'node:crypto';

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

/** @param {unknown} value */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

/** sha256 hex digest of the canonical JSON of `value`. */
export function canonicalHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Byte length of the canonical JSON of `value`, as UTF-8. */
export function canonicalBytes(value) {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}
