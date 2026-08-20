/**
 * Persist an updated deny marker (consume / repair). ensureDenyMarker will not
 * overwrite an existing valid marker, so privileged writers use this path.
 */

import { denyPath, assertSafeSessionId, normalizeBindField, readDenyMarker } from './deny-marker.mjs';
import { writeJsonAtomic } from './atomic-json.mjs';

/**
 * Atomically write a full deny record object to the marker path.
 * @param {string} root
 * @param {object} record — must include session_id and status open|consumed
 * @returns {{ ok: true, path: string, record: object } | { ok: false, error: string }}
 */
export function writeDenyRecord(root, record, opts = {}) {
  if (!record || typeof record !== 'object') {
    return { ok: false, error: 'missing record' };
  }
  try {
    assertSafeSessionId(record.session_id);
  } catch (err) {
    return { ok: false, error: err?.message || 'unsafe session id' };
  }
  if (record.status !== 'open' && record.status !== 'consumed') {
    return { ok: false, error: 'invalid status' };
  }
  const normalized = {
    ...record,
    ticket_id: normalizeBindField(record.ticket_id),
    content_hash: normalizeBindField(record.content_hash),
    schema: record.schema ?? 1,
  };
  const path = denyPath(root, record.session_id);
  const wrote = writeJsonAtomic(path, normalized, opts);
  if (!wrote.ok) return { ok: false, error: wrote.error };
  return { ok: true, path, record: normalized, bytes: wrote.bytes };
}

/**
 * Refuse to write over a marker that moved since the caller read it. The
 * session lock keeps handoff processes off each other; this catches a writer
 * that never took it (older CLI, hand-edited marker) before the clobber.
 * @param {object} expected — the record the caller preflighted on
 * @returns {{ ok: true, record: object } | { ok: false, error: string, exitCode: number }}
 */
export function markerUnchanged(root, sessionId, expected, opts = {}) {
  // readDenyMarker carries a record whenever ok — the reason names why not.
  const fresh = readDenyMarker(root, sessionId, opts);
  if (!fresh.ok) {
    return {
      ok: false,
      error: `deny marker for session=${sessionId} became unreadable (${fresh.reason})`,
      exitCode: 2,
    };
  }
  const r = fresh.record;
  if (
    r.status !== expected?.status ||
    r.ticket_id !== normalizeBindField(expected?.ticket_id) ||
    r.content_hash !== normalizeBindField(expected?.content_hash)
  ) {
    return {
      ok: false,
      error: `deny marker for session=${sessionId} changed under this command (concurrent consume or repair) — re-read and re-run`,
      exitCode: 2,
    };
  }
  return { ok: true, record: r };
}

/**
 * Update an open deny's ticket_id + content_hash (host repair). Leaves status=open.
 *
 * `contentKind` travels with the hash it describes, and is CLEARED when absent.
 * A hash rebound to something else is not the old capture, so carrying a stale
 * `content_kind: 'capture'` forward would leave readers demanding a capture that
 * this hash was never derived from — a deny nothing could clear.
 *
 * @returns {{ ok: true, record: object } | { ok: false, error: string }}
 */
export function repairDenyBinds(
  root,
  sessionId,
  { ticketId, contentHash, contentKind = null, host },
  opts = {},
) {
  const existing = readDenyMarker(root, sessionId, opts);
  if (!existing.ok || !existing.record) {
    return { ok: false, error: existing.reason || 'missing deny marker' };
  }
  if (existing.record.status !== 'open') {
    return { ok: false, error: 'deny record is not open' };
  }
  const ticket_id = normalizeBindField(ticketId);
  const content_hash = normalizeBindField(contentHash);
  if (!ticket_id || !content_hash) {
    return { ok: false, error: 'repair requires non-null ticket_id and content_hash' };
  }
  const next = {
    ...existing.record,
    ticket_id,
    content_hash,
    status: 'open',
  };
  const content_kind = normalizeBindField(contentKind);
  if (content_kind) next.content_kind = content_kind;
  else delete next.content_kind;
  if (host != null) next.host = host;
  return writeDenyRecord(root, next, opts);
}
