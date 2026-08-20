/**
 * Final handoff checkpoint: `.adlc/handoffs/finals/<session_id>.json`
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '@adlc/core';
import { normalizeBindField } from './deny-marker.mjs';
import { finalPath } from './paths.mjs';
import { readJsonFile, writeJsonAtomic } from './atomic-json.mjs';

/**
 * Hash the final body (without content_hash) when the operator did not supply one.
 * @param {object} body
 * @returns {string}
 */
export function hashFinalBody(body) {
  // written_at is metadata — exclude so a refresh with the same binds keeps the hash.
  const { content_hash: _drop, written_at: _ts, ...rest } = body;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

/**
 * `content_kind` value meaning "content_hash is sha256 over a stored capture
 * body", which readers must re-derive from disk rather than trust.
 */
export const CONTENT_KIND_CAPTURE = 'capture';

/**
 * Build a schema-1 final checkpoint object.
 *
 * `content_kind` is additive and omitted unless asked for: a record without it
 * means exactly what it meant before — a metadata hash nobody can re-derive —
 * so existing finals need no migration and their body hash does not move.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string|null} [opts.ticketId]
 * @param {string|null} [opts.contentHash] — when null/absent, derived from body
 * @param {string|null} [opts.contentKind] — e.g. 'capture'
 * @param {string} [opts.host='local']
 * @param {() => string} [opts.now]
 */
export function buildFinal({
  sessionId,
  ticketId = null,
  contentHash = null,
  contentKind = null,
  host = 'local',
  now = () => new Date().toISOString(),
}) {
  const draft = {
    schema: 1,
    session_id: sessionId,
    ticket_id: normalizeBindField(ticketId),
    written_at: now(),
    host: typeof host === 'string' && host.trim().length > 0 ? host.trim() : 'local',
  };
  const provided = normalizeBindField(contentHash);
  const content_hash = provided ?? hashFinalBody(draft);
  const kind = normalizeBindField(contentKind);
  return kind ? { ...draft, content_hash, content_kind: kind } : { ...draft, content_hash };
}

/**
 * @returns {{ ok: true, final: object } | { ok: false, error: string }}
 */
export function readFinal(root, sessionId, opts = {}) {
  const path = finalPath(root, sessionId);
  const got = readJsonFile(path, opts);
  if (!got.ok) return { ok: false, error: got.error };
  const f = got.value;
  if (f.schema !== 1 || f.session_id !== sessionId) {
    return { ok: false, error: 'invalid_final' };
  }
  return { ok: true, final: f };
}

/**
 * Persist a final checkpoint.
 * @returns {{ ok: true, final: object, path: string } | { ok: false, error: string }}
 */
export function writeFinal(root, fields, opts = {}) {
  const final = buildFinal(fields);
  const path = finalPath(root, fields.sessionId);
  const wrote = writeJsonAtomic(path, final, opts);
  if (!wrote.ok) return { ok: false, error: wrote.error };
  return { ok: true, final, path, bytes: wrote.bytes };
}
