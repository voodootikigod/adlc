import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

/**
 * Fail-closed deny marker helpers. Injectable fs for tests.
 */

export function denyPath(root, sessionId) {
  return join(root, '.adlc', 'handoffs', 'denies', `${sessionId}.json`);
}

/**
 * Validate a deny marker file for currentSessionId.
 * @returns {{ ok: boolean, record?: object, deny: boolean, reason: string }}
 */
export function readDenyMarker(root, sessionId, { fs = { readFileSync, existsSync } } = {}) {
  const path = denyPath(root, sessionId);
  if (!fs.existsSync(path)) {
    return { ok: false, deny: true, reason: 'missing_marker' };
  }
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return { ok: false, deny: true, reason: 'unreadable_marker' };
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return { ok: false, deny: true, reason: 'corrupt_json' };
  }
  if (!record || typeof record !== 'object') {
    return { ok: false, deny: true, reason: 'invalid_shape' };
  }
  if (record.session_id !== sessionId || basename(path) !== `${sessionId}.json`) {
    return { ok: false, deny: true, reason: 'session_id_mismatch' };
  }
  if (record.status !== 'open' && record.status !== 'consumed') {
    return { ok: false, deny: true, reason: 'invalid_status' };
  }
  return { ok: true, deny: false, record, reason: 'ok' };
}

/**
 * Ensure marker exists; on failure return processSticky recommendation.
 * @returns {{ ok: boolean, processSticky: boolean, reason: string }}
 */
export function ensureDenyMarker(
  root,
  { sessionId, ticketId = null, contentHash = null, host = 'local' },
  {
    fs = { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync },
    now = () => new Date().toISOString(),
  } = {},
) {
  const path = denyPath(root, sessionId);
  const dir = dirname(path);
  const record = {
    session_id: sessionId,
    ticket_id: ticketId,
    content_hash: contentHash,
    status: 'open',
    since: now(),
    host,
    schema: 1,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, path);
  } catch (err) {
    return {
      ok: false,
      processSticky: true,
      reason: `write_failed:${err?.code || err?.message || 'error'}`,
    };
  }
  const check = readDenyMarker(root, sessionId, { fs });
  if (!check.ok) {
    return { ok: false, processSticky: true, reason: check.reason };
  }
  return { ok: true, processSticky: false, reason: 'ok' };
}

/**
 * Re-entry: if absolute handoff still applies and marker missing/bad → sticky deny.
 */
export function evaluateMarkerOnReentry(root, sessionId, { absoluteHandoff, fs } = {}) {
  if (!absoluteHandoff) {
    const check = readDenyMarker(root, sessionId, { fs });
    // Cooling does not clear open deny if marker exists
    if (check.ok && check.record?.status === 'open') {
      return { deny: true, processSticky: false, reason: 'open_deny_persists' };
    }
    if (!check.ok && check.reason === 'missing_marker') {
      return { deny: false, processSticky: false, reason: 'no_handoff_no_marker' };
    }
    if (!check.ok) return { deny: true, processSticky: true, reason: check.reason };
    return { deny: false, processSticky: false, reason: 'ok' };
  }
  const check = readDenyMarker(root, sessionId, { fs });
  if (!check.ok) {
    return { deny: true, processSticky: true, reason: check.reason, retryWrite: true };
  }
  return { deny: true, processSticky: false, reason: 'handoff_active' };
}
