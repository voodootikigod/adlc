/**
 * Bypass-grant cache: `.adlc/handoffs/<session_id>.bypass-grant.json`
 *
 * Signed with HMAC-SHA256 under ADLC_MANIFEST_KEY over canonical JSON of the
 * bind fields, mirroring resume-auth.mjs's cache/signature pattern. Written by
 * `handoff bypass --write` (bin/handoff.mjs), read and CONSUMED (deleted) by
 * the adapter the first time it authorizes a mutation — see
 * evaluateHandoffPreToolUse in adapter.mjs. Unverifiable ≡ absent, same as
 * resume-auth. A grant older than BYPASS_GRANT_TTL_MS is also treated as
 * absent, a defense-in-depth ceiling for the case consumption itself fails
 * (see thresholds.mjs's BYPASS_GRANT_TTL_MS comment for the full rationale).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { canonicalJson } from '@adlc/core';
import { bypassGrantPath } from './paths.mjs';
import { readJsonFile, writeJsonAtomic } from './atomic-json.mjs';
import { BYPASS_GRANT_TTL_MS } from './thresholds.mjs';

export const BYPASS_GRANT_SCHEMA = 1;

function payloadBytes({ session_id, unbound_reason }) {
  return canonicalJson({ schema: BYPASS_GRANT_SCHEMA, session_id, unbound_reason });
}

/**
 * @param {string} key
 * @param {object} fields
 * @returns {string} hex HMAC
 */
export function signBypassGrant(key, fields) {
  return createHmac('sha256', key).update(payloadBytes(fields)).digest('hex');
}

/**
 * @param {string} key
 * @param {object} doc
 * @returns {boolean}
 */
export function verifyBypassGrantSig(key, doc) {
  if (!doc || typeof doc.sig !== 'string' || doc.sig.length === 0) return false;
  if (typeof key !== 'string' || key.length === 0) return false;
  const expected = signBypassGrant(key, doc);
  const a = Buffer.from(doc.sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Build a signed bypass-grant document for the session cache.
 */
export function buildBypassGrantDoc({ sessionId, unboundReason = null, key, now = () => new Date().toISOString() }) {
  const fields = {
    session_id: sessionId,
    unbound_reason: typeof unboundReason === 'string' && unboundReason.trim().length > 0 ? unboundReason : null,
  };
  return {
    schema: BYPASS_GRANT_SCHEMA,
    ...fields,
    written_at: now(),
    sig: signBypassGrant(key, fields),
  };
}

/**
 * Read the bypass grant for a session. Unverifiable, session-mismatched, or
 * past BYPASS_GRANT_TTL_MS since written_at ⇒ treated as absent (null).
 * @returns {{ session_id: string, unbound_reason: string|null, written_at: string, verified: boolean } | null}
 */
export function readBypassGrant(root, sessionId, { key = null, fs, now = () => Date.now() } = {}) {
  const got = readJsonFile(bypassGrantPath(root, sessionId), fs ? { fs } : {});
  if (!got.ok) return null;
  const doc = got.value;
  const session_id = doc.session_id;
  const unbound_reason = doc.unbound_reason ?? null;
  const written_at = doc.written_at;
  if (typeof session_id !== 'string' || session_id !== sessionId) return null;
  if (unbound_reason !== null && typeof unbound_reason !== 'string') return null;
  if (typeof written_at !== 'string') return null;
  const writtenMs = Date.parse(written_at);
  if (!Number.isFinite(writtenMs)) return null;
  if (now() - writtenMs > BYPASS_GRANT_TTL_MS) return null;
  const verified = key != null && verifyBypassGrantSig(key, doc) === true;
  return { session_id, unbound_reason, written_at, verified };
}

/**
 * Persist a signed bypass grant for the session.
 */
export function writeBypassGrant(root, sessionId, { unboundReason = null } = {}, { key, fs } = {}) {
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, error: 'missing signing key' };
  }
  const doc = buildBypassGrantDoc({ sessionId, unboundReason, key });
  const path = bypassGrantPath(root, sessionId);
  const wrote = writeJsonAtomic(path, doc, fs ? { fs } : {});
  if (!wrote.ok) return { ok: false, error: wrote.error };
  return { ok: true, path, doc };
}

/**
 * Best-effort removal of a bypass grant — the ONE-SHOT consumption step: the
 * adapter calls this immediately after a grant authorizes a mutation, so the
 * next tool call finds no grant and falls back to ordinary deny evaluation.
 * @returns {boolean} true when the cache is gone afterwards
 */
export function removeBypassGrant(root, sessionId, { fs = { existsSync, unlinkSync } } = {}) {
  const path = bypassGrantPath(root, sessionId);
  try {
    if (fs.existsSync(path)) fs.unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
