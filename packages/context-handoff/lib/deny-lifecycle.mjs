/**
 * Deny record lifecycle: open → consumed. Denier session stays sticky (D2).
 */

/**
 * @param {object} record
 * @param {string} consumerSessionId
 * @returns {{ ok: true, record: object } | { ok: false, error: string }}
 */
export function consumeDenyRecord(record, consumerSessionId) {
  if (!record || typeof record !== 'object') {
    return { ok: false, error: 'missing deny record' };
  }
  if (record.status !== 'open') {
    return { ok: false, error: 'deny record is not open' };
  }
  if (consumerSessionId === record.session_id) {
    return { ok: false, error: 'same-session consume forbidden' };
  }
  if (record.content_hash == null || record.ticket_id == null) {
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
