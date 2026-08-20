/**
 * Resume-auth cache: `.adlc/handoffs/<session_id>.resume-auth.json`
 *
 * Signed with HMAC-SHA256 under ADLC_MANIFEST_KEY over canonical JSON of the
 * bind fields. Unverifiable ≡ absent (verified:false / null from readers).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { canonicalJson } from '@adlc/core';
import { resumeAuthPath } from './paths.mjs';
import { readJsonFile, writeJsonAtomic, writeTextExclusive } from './atomic-json.mjs';

export const SCHEMA = 1;

function payloadBytes({ ticket_id, content_hash, deny_session_id, consumer_session_id }) {
  return canonicalJson({
    schema: SCHEMA,
    ticket_id,
    content_hash,
    deny_session_id,
    consumer_session_id,
  });
}

/**
 * @param {string} key
 * @param {object} fields
 * @returns {string} hex HMAC
 */
export function signResumeAuth(key, fields) {
  return createHmac('sha256', key).update(payloadBytes(fields)).digest('hex');
}

/**
 * @param {string} key
 * @param {object} doc
 * @returns {boolean}
 */
export function verifyResumeAuthSig(key, doc) {
  if (!doc || typeof doc.sig !== 'string' || doc.sig.length === 0) return false;
  if (typeof key !== 'string' || key.length === 0) return false;
  const expected = signResumeAuth(key, doc);
  const a = Buffer.from(doc.sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Build a signed resume-auth document for the consumer session cache.
 */
export function buildResumeAuthDoc({
  ticketId,
  contentHash,
  denySessionId,
  consumerSessionId,
  key,
  now = () => new Date().toISOString(),
}) {
  const fields = {
    ticket_id: ticketId,
    content_hash: contentHash,
    deny_session_id: denySessionId,
    consumer_session_id: consumerSessionId,
  };
  return {
    schema: SCHEMA,
    ...fields,
    written_at: now(),
    sig: signResumeAuth(key, fields),
  };
}

/**
 * Read resume-auth for a consumer session. Unverifiable ⇒ verified:false (treat as absent).
 * The document names the session it was minted for: a valid signature over another
 * session's fields must not authorize this one, so a mismatch reads as absent.
 * @returns {{ ticket_id: string, content_hash: string, deny_session_id: string, consumer_session_id: string, verified: boolean } | null}
 */
export function readResumeAuth(root, sessionId, { key = null, fs } = {}) {
  const got = readJsonFile(resumeAuthPath(root, sessionId), fs ? { fs } : {});
  if (!got.ok) return null;
  const doc = got.value;
  const ticket_id = doc.ticket_id;
  const content_hash = doc.content_hash;
  const deny_session_id = doc.deny_session_id;
  const consumer_session_id = doc.consumer_session_id;
  if (
    typeof ticket_id !== 'string' ||
    typeof content_hash !== 'string' ||
    typeof deny_session_id !== 'string' ||
    typeof consumer_session_id !== 'string'
  ) {
    return null;
  }
  if (consumer_session_id !== sessionId) return null;
  const verified = key != null && verifyResumeAuthSig(key, doc) === true;
  return {
    ticket_id,
    content_hash,
    deny_session_id,
    consumer_session_id,
    verified,
  };
}

/**
 * Persist a signed resume-auth cache for the consumer session.
 *
 * `exclusive` makes the write a CLAIM on the session id: the file is created
 * with O_EXCL, so two continuations naming the same successor cannot both
 * believe they authorized it. Checking `existsSync` first and then renaming
 * leaves a window where both pass the check and the later rename silently
 * replaces the earlier grant — and the denier's lock cannot close it, because
 * the two runs are consuming DIFFERENT denies.
 *
 * @param {{ key: string, exclusive?: boolean, fs?: object }} opts
 * @returns {{ ok: true, path, doc, resumeAuth, created: boolean }
 *          | { ok: false, error: string, exists?: boolean }}
 */
export function writeResumeAuth(root, consumerSessionId, fields, { key, exclusive = false, fs } = {}) {
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, error: 'missing signing key' };
  }
  const doc = buildResumeAuthDoc({ ...fields, consumerSessionId, key });
  const path = resumeAuthPath(root, consumerSessionId);
  const body = `${JSON.stringify(doc, null, 2)}\n`;
  const wrote = exclusive
    ? writeTextExclusive(path, body, fs ? { fs } : {})
    : writeJsonAtomic(path, doc, fs ? { fs } : {});
  if (!wrote.ok) return { ok: false, error: wrote.error, exists: wrote.exists === true };
  return {
    ok: true,
    path,
    doc,
    bytes: wrote.bytes,
    created: exclusive,
    resumeAuth: readResumeAuth(root, consumerSessionId, { key, fs }),
  };
}

/**
 * Best-effort removal of a resume-auth cache — used to roll back a partial resume.
 * @returns {boolean} true when the cache is gone afterwards
 */
export function removeResumeAuth(root, consumerSessionId, { fs = { existsSync, unlinkSync } } = {}) {
  const path = resumeAuthPath(root, consumerSessionId);
  try {
    if (fs.existsSync(path)) fs.unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
