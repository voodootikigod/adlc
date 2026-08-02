/**
 * Normative D1–D3 mutation gate (pure).
 *
 * @typedef {{ session_id: string, ticket_id: string|null, content_hash: string|null, status: 'open'|'consumed' }} DenyRecord
 * @typedef {{ ticket_id: string, content_hash: string, verified: boolean }} ResumeAuth
 * @typedef {boolean|null|{ unboundReason: string }} BypassGrant
 */

import { isSafeSessionId } from './deny-marker.mjs';

/** True when a bind field is a non-empty string (whitespace-only ≡ unbound). */
export function isBoundField(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Fail-closed session identity for the gate — same rules as assertSafeSessionId.
 * @param {unknown} sessionId
 * @returns {boolean}
 */
export function isUsableSessionId(sessionId) {
  return isSafeSessionId(sessionId);
}

/**
 * A deny record is shape-valid only when session_id is safe and status is
 * exactly open|consumed. Anything else fails closed under D3.
 * @param {unknown} record
 * @returns {boolean}
 */
export function isValidDenyRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (!isSafeSessionId(record.session_id)) return false;
  return record.status === 'open' || record.status === 'consumed';
}

/**
 * Normalize bypass grant.
 * - false/null/absent → no bypass
 * - true → legacy bound-only (lifts D2 for current session; does NOT authorize unbound)
 * - { unboundReason: non-empty string } → unbound operator override (bound + unbound; lifts D2)
 * @param {BypassGrant} [bypassForSession]
 * @returns {{ active: boolean, allowUnbound: boolean }}
 */
export function normalizeBypassGrant(bypassForSession) {
  if (bypassForSession === true) {
    return { active: true, allowUnbound: false };
  }
  if (
    bypassForSession &&
    typeof bypassForSession === 'object' &&
    typeof bypassForSession.unboundReason === 'string' &&
    bypassForSession.unboundReason.trim().length > 0
  ) {
    return { active: true, allowUnbound: true };
  }
  return { active: false, allowUnbound: false };
}

/**
 * Per-record authorization (spec: universal quantification over open denies).
 * Unverifiable/missing manifest ⇒ not authorized (including bypass).
 * Legacy `true` authorizes bound open records only; unbound needs
 * `{ unboundReason }` operator override.
 * @param {object} opts
 * @param {DenyRecord} opts.record
 * @param {ResumeAuth|null} [opts.resumeAuth]
 * @param {BypassGrant} [opts.bypassForSession=false]
 * @param {boolean} [opts.manifestVerifyFailed=false]
 */
export function authorized({
  record,
  resumeAuth = null,
  bypassForSession = false,
  manifestVerifyFailed = false,
} = {}) {
  if (!record) return false;
  // Spec: Unverifiable/missing manifest ⇒ not authorized.
  if (manifestVerifyFailed) return false;

  const grant = normalizeBypassGrant(bypassForSession);
  const unbound = !isBoundField(record.ticket_id) || !isBoundField(record.content_hash);

  if (grant.active) {
    if (unbound) return grant.allowUnbound === true;
    return true;
  }

  // Pre-bind / unbound: resume-auth never suffices (null OR empty/whitespace).
  if (unbound) return false;

  if (!resumeAuth || resumeAuth.verified !== true) return false;
  if (resumeAuth.ticket_id !== record.ticket_id) return false;
  if (resumeAuth.content_hash !== record.content_hash) return false;
  // Optional record bind: when present, resume-auth is not a cross-deny bearer.
  if (
    typeof resumeAuth.deny_session_id === 'string' &&
    resumeAuth.deny_session_id.trim().length > 0 &&
    resumeAuth.deny_session_id !== record.session_id
  ) {
    return false;
  }
  return true;
}

/**
 * @param {object} opts
 * @param {boolean} [opts.processStickyDeny=false]
 * @param {string} opts.currentSessionId
 * @param {DenyRecord[]} [opts.denyRecords=[]]
 * @param {ResumeAuth|null} [opts.resumeAuth=null]
 * @param {BypassGrant} [opts.bypassForSession=false]
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
  denyStoreUnavailable = false,
} = {}) {
  const reasons = [];
  // D1 is independent of TTY bypass.
  if (processStickyDeny) reasons.push('D1:process_sticky');
  if (denyStoreUnavailable) reasons.push('D0:deny_store_unavailable');

  // Missing/blank/padded/unsafe session identity cannot evaluate D2 — fail closed.
  if (!isUsableSessionId(currentSessionId)) {
    reasons.push('D0:invalid_session_id');
    return { deny: true, reasons };
  }

  if (!Array.isArray(denyRecords)) {
    reasons.push('D0:invalid_deny_records');
    return { deny: true, reasons };
  }

  // Manifest failure inertifies bypass (authorized + D2 lift).
  const grant = manifestVerifyFailed
    ? { active: false, allowUnbound: false }
    : normalizeBypassGrant(bypassForSession);

  const self = denyRecords.filter((r) => r && r.session_id === currentSessionId);
  // Spec: active bypass can authorize denier briefly — do not push D2 when bypassed.
  if (self.length > 0 && !grant.active) reasons.push('D2:denier_session');

  const effectiveAuth = manifestVerifyFailed ? null : resumeAuth;
  for (const r of denyRecords) {
    if (!r) continue;
    if (!isValidDenyRecord(r)) {
      const label = typeof r.session_id === 'string' && r.session_id.length > 0 ? r.session_id : '?';
      reasons.push(`D3:invalid_record:${label}`);
      continue;
    }
    if (r.status !== 'open') continue;
    if (
      !authorized({
        record: r,
        resumeAuth: effectiveAuth,
        bypassForSession: grant.active
          ? bypassForSession
          : false,
        manifestVerifyFailed,
      })
    ) {
      reasons.push(`D3:unauthorized_open:${r.session_id}`);
    }
  }

  return { deny: reasons.length > 0, reasons };
}
