// canonical.mjs — deterministic JSON canonicalization + equality (zero-dep).
//
// The 3-way conflict detection and push-idempotency both hinge on "did the block
// actually change?" — which is only answerable if two semantically-equal blocks
// serialize identically. This module is that single canonicalization authority.
//
// Rules: object keys sorted recursively; arrays kept in order; numbers via the
// engine's deterministic Number->string (so 2e5 and 200000 compare equal); no
// insignificant whitespace. `omit` drops keys (e.g. `$schema`) at any depth so
// an editor hint never registers as a change. Text comparison uses
// normalizeNewlines so CRLF (GitHub web edits) vs LF (local) is not a diff.

import { createHash } from 'node:crypto';

function sortValue(value, omit) {
  if (Array.isArray(value)) return value.map((v) => sortValue(v, omit));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (omit.includes(key)) continue;
      out[key] = sortValue(value[key], omit);
    }
    return out;
  }
  return value;
}

/** Canonical JSON string for an object/value. */
export function canonicalize(value, { omit = [] } = {}) {
  return JSON.stringify(sortValue(value, omit));
}

/** True when two values canonicalize identically (key-order- and number-form-insensitive). */
export function canonicalEqual(a, b, opts) {
  return canonicalize(a, opts) === canonicalize(b, opts);
}

/** Stable sha256 over the canonical form — the sidecar 3-way base hash. */
export function canonicalHash(value, opts) {
  return createHash('sha256').update(canonicalize(value, opts)).digest('hex');
}

/** Collapse CRLF/CR to LF so issue-body text from different sources compares cleanly. */
export function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
