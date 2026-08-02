/**
 * Normative D1–D3 mutation gate (pure).
 *
 * @typedef {{ session_id: string, ticket_id: string|null, content_hash: string|null, status: 'open'|'consumed' }} DenyRecord
 * @typedef {{ ticket_id: string, content_hash: string, verified: boolean }} ResumeAuth
 */

/** True when a bind field is a non-empty string (whitespace-only ≡ unbound). */
export function isBoundField(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Fail-closed session identity for the gate.
 * @param {unknown} sessionId
 * @returns {boolean}
 */
export function isUsableSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.trim().length > 0 && sessionId.trim() === sessionId;
}

/**
 * Per-record authorization (spec: universal quantification over open denies).
 * TTY bypass authorizes the caller briefly (including null-ticket/null-hash).
 * @param {object} opts
 * @param {DenyRecord} opts.record
 * @param {ResumeAuth|null} [opts.resumeAuth]
 * @param {boolean} [opts.bypassForSession=false]
 */
export function authorized({ record, resumeAuth = null, bypassForSession = false } = {}) {
  if (!record) return false;
  if (bypassForSession) return true;

  // Pre-bind / unbound: resume-auth never suffices (null OR empty/whitespace).
  if (!isBoundField(record.ticket_id) || !isBoundField(record.content_hash)) return false;

  if (!resumeAuth || resumeAuth.verified !== true) return false;
  if (resumeAuth.ticket_id !== record.ticket_id) return false;
  if (resumeAuth.content_hash !== record.content_hash) return false;
  return true;
}

/**
 * @param {object} opts
 * @param {boolean} [opts.processStickyDeny=false]
 * @param {string} opts.currentSessionId
 * @param {DenyRecord[]} [opts.denyRecords=[]]
 * @param {ResumeAuth|null} [opts.resumeAuth=null]
 * @param {boolean} [opts.bypassForSession=false]
 * @param {boolean} [opts.manifestVerifyFailed=false]
 * @returns {{ deny: boolean, reasons: string[] }}
 */
export function evaluateMutationGate({
  processStickyDeny = false,
  currentSessionId,
  denyRecords = [],
  resumeAuth = null,
  bypassForSession = false,
  manifestVerifyFailed = false,
} = {}) {
  const reasons = [];
  // D1 is independent of TTY bypass.
  if (processStickyDeny) reasons.push('D1:process_sticky');

  // Missing/blank/padded session identity cannot evaluate D2 — fail closed.
  if (!isUsableSessionId(currentSessionId)) {
    reasons.push('D0:invalid_session_id');
    return { deny: true, reasons };
  }

  const self = denyRecords.filter((r) => r && r.session_id === currentSessionId);
  // Spec: TTY bypass can authorize denier briefly — do not push D2 when bypassed.
  if (self.length > 0 && !bypassForSession) reasons.push('D2:denier_session');

  const effectiveAuth = manifestVerifyFailed ? null : resumeAuth;
  const open = denyRecords.filter((r) => r && r.status === 'open');
  for (const r of open) {
    if (!authorized({ record: r, resumeAuth: effectiveAuth, bypassForSession })) {
      reasons.push(`D3:unauthorized_open:${r.session_id}`);
    }
  }

  return { deny: reasons.length > 0, reasons };
}
