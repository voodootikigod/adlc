// session-identity.mjs — strict Cursor session id resolution (T64).
// Accepts only session_id / conversation_id (+ env ADLC_CURSOR_SESSION_ID).
// Rejects generation_id / thread_id as session keys.

import { createHash } from 'node:crypto';

export const SESSION_ENV_KEY = 'ADLC_CURSOR_SESSION_ID';

const PAYLOAD_SESSION_KEYS = Object.freeze(['session_id', 'sessionId', 'conversation_id', 'conversationId']);
const REJECTED_AS_SESSION_KEYS = Object.freeze(['thread_id', 'threadId', 'generation_id', 'generationId']);

/**
 * @returns {{
 *   ok: true, sessionId: string|null, source: 'env'|'payload'|'anonymous'|'conflict',
 *   conflict?: boolean, message?: string
 * }}
 */
export function resolveSessionIdentity(payload = {}, env = process.env) {
  const envId = trimmed(env?.[SESSION_ENV_KEY]);
  const payloadIds = collectPayloadSessionIds(payload);

  if (payloadIds.conflict) {
    return {
      ok: false,
      sessionId: null,
      source: 'conflict',
      conflict: true,
      message: payloadIds.message,
    };
  }

  const payloadId = payloadIds.id;

  if (envId && payloadId && envId !== payloadId) {
    return {
      ok: false,
      sessionId: null,
      source: 'conflict',
      conflict: true,
      message:
        `${SESSION_ENV_KEY} ("${envId}") conflicts with payload session id ("${payloadId}"). ` +
        `Named session state will not be read or mutated.`,
    };
  }

  if (envId) return { ok: true, sessionId: envId, source: 'env' };
  if (payloadId) return { ok: true, sessionId: payloadId, source: 'payload' };
  return { ok: true, sessionId: null, source: 'anonymous' };
}

/** SHA-256 hex of the exact session id string (collision-resistant safeId). */
export function sessionSafeId(sessionId) {
  return createHash('sha256').update(String(sessionId), 'utf8').digest('hex');
}

function trimmed(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function collectPayloadSessionIds(payload) {
  if (!payload || typeof payload !== 'object') return { id: null };

  const found = [];
  for (const key of PAYLOAD_SESSION_KEYS) {
    if (!Object.hasOwn(payload, key)) continue;
    const v = trimmed(payload[key]);
    if (v) found.push({ key, v });
  }

  // Rejected keys must not be used even if present alone.
  for (const key of REJECTED_AS_SESSION_KEYS) {
    if (Object.hasOwn(payload, key) && trimmed(payload[key]) && found.length === 0) {
      // generation/thread-only → anonymous (not a named session)
      return { id: null };
    }
  }

  if (found.length === 0) return { id: null };
  const first = found[0].v;
  for (const item of found) {
    if (item.v !== first) {
      return {
        id: null,
        conflict: true,
        message: `payload session aliases disagree (${found.map((f) => `${f.key}=${f.v}`).join(', ')})`,
      };
    }
  }
  return { id: first };
}
