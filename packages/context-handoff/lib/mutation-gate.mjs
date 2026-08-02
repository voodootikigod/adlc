/**
 * Normative D1–D3 mutation gate (pure).
 *
 * @typedef {{ session_id: string, ticket_id: string|null, content_hash: string|null, status: 'open'|'consumed' }} DenyRecord
 * @typedef {{ ticket_id: string, content_hash: string, verified: boolean }} ResumeAuth
 */

/**
 * Per-record authorization (spec: universal quantification over open denies).
 * @param {object} opts
 * @param {DenyRecord} opts.record
 * @param {ResumeAuth|null} [opts.resumeAuth]
 * @param {boolean} [opts.bypassForSession=false]
 */
export function authorized({ record, resumeAuth = null, bypassForSession = false } = {}) {
  if (!record) return false;
  if (bypassForSession) return true;

  // Pre-bind / null-hash: resume-auth never suffices.
  if (record.ticket_id == null || record.content_hash == null) return false;

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
  if (processStickyDeny) reasons.push('D1:process_sticky');

  const self = denyRecords.filter((r) => r && r.session_id === currentSessionId);
  if (self.length > 0) reasons.push('D2:denier_session');

  const effectiveAuth = manifestVerifyFailed ? null : resumeAuth;
  const open = denyRecords.filter((r) => r && r.status === 'open');
  for (const r of open) {
    if (!authorized({ record: r, resumeAuth: effectiveAuth, bypassForSession })) {
      reasons.push(`D3:unauthorized_open:${r.session_id}`);
    }
  }

  return { deny: reasons.length > 0, reasons };
}
