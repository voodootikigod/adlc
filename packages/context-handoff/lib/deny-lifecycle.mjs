/**
 * Deny record lifecycle: open → consumed. Denier session stays sticky (D2).
 */

import { isBoundField } from './mutation-gate.mjs';

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
  if (typeof consumerSessionId !== 'string' || consumerSessionId.trim().length === 0) {
    return { ok: false, error: 'missing consumer session id' };
  }
  if (consumerSessionId === record.session_id) {
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

/**
 * After consume: denier still D2; consumed R drops from D3.
 */
export function postConsumeGateInput({ denierSessionId, consumerSessionId, records, resumeAuth }) {
  return {
    currentSessionId: consumerSessionId,
    denyRecords: records,
    resumeAuth,
    processStickyDeny: false,
    // helper for tests: is denier still sticky?
    denierStillDenied: records.some((r) => r.session_id === denierSessionId),
  };
}
