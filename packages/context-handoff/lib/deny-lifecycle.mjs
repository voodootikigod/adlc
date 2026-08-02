/**
 * Deny record lifecycle: open → consumed. Denier session stays sticky (D2).
 */

import { isBoundField } from './mutation-gate.mjs';
import { assertSafeSessionId } from './deny-marker.mjs';

/**
 * Canonical session id for lifecycle/gate comparisons.
 * Rejects missing, empty, whitespace-padded, and unsafe ids.
 * @param {unknown} sessionId
 * @param {string} label
 * @returns {{ ok: true, id: string } | { ok: false, error: string }}
 */
export function requireSessionId(sessionId, label = 'session id') {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    return { ok: false, error: `missing ${label}` };
  }
  if (sessionId.trim() !== sessionId) {
    return { ok: false, error: `padded ${label}` };
  }
  try {
    assertSafeSessionId(sessionId);
  } catch (err) {
    return { ok: false, error: err?.message || `unsafe ${label}` };
  }
  return { ok: true, id: sessionId };
}

/**
 * @param {object} record
 * @param {string} consumerSessionId
 * @returns {{ ok: true, record: object } | { ok: false, error: string, exitCode?: number }}
 */
export function consumeDenyRecord(record, consumerSessionId) {
  if (!record || typeof record !== 'object') {
    return { ok: false, error: 'missing deny record' };
  }
  if (record.status !== 'open') {
    return { ok: false, error: 'deny record is not open' };
  }
  const denier = requireSessionId(record.session_id, 'deny record session id');
  if (!denier.ok) {
    return { ok: false, error: denier.error };
  }
  const consumer = requireSessionId(consumerSessionId, 'consumer session id');
  if (!consumer.ok) {
    return { ok: false, error: consumer.error };
  }
  if (consumer.id === record.session_id) {
    return { ok: false, error: 'same-session consume forbidden', exitCode: 2 };
  }
  if (!isBoundField(record.content_hash) || !isBoundField(record.ticket_id)) {
    return { ok: false, error: 'cannot consume without ticket_id and content_hash' };
  }
  return {
    ok: true,
    record: { ...record, status: 'consumed' },
  };
}
