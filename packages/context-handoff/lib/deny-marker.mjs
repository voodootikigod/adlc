import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';

/**
 * Fail-closed deny marker helpers. Injectable fs for tests.
 */

/**
 * Reject empty / path-separators / `..` / basename mismatch so deny paths
 * cannot escape `.adlc/handoffs/denies/`.
 * @param {unknown} sessionId
 * @returns {true}
 */
export function assertSafeSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('unsafe sessionId: empty');
  }
  if (sessionId.trim().length === 0 || sessionId.trim() !== sessionId) {
    throw new Error('unsafe sessionId: padded');
  }
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
    throw new Error('unsafe sessionId: path traversal');
  }
  if (basename(sessionId) !== sessionId) {
    throw new Error('unsafe sessionId: basename mismatch');
  }
  return true;
}

/** Normalize bind fields: empty/whitespace → null (unbound). */
export function normalizeBindField(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function denyPath(root, sessionId) {
  assertSafeSessionId(sessionId);
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
 * Idempotent: never rewrite an already-valid open or consumed marker
 * (preserves host-repaired ticket_id/content_hash and consumed status).
 * Unreadable existing markers fail closed without clobber.
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
  assertSafeSessionId(sessionId);
  const existing = readDenyMarker(root, sessionId, { fs });
  if (existing.ok) {
    return { ok: true, processSticky: false, reason: 'already_present' };
  }
  // Exists but unreadable: never clobber durable state.
  if (existing.reason === 'unreadable_marker') {
    return { ok: false, processSticky: true, reason: 'unreadable_marker' };
  }

  const path = denyPath(root, sessionId);
  const dir = dirname(path);
  const record = {
    session_id: sessionId,
    ticket_id: normalizeBindField(ticketId),
    content_hash: normalizeBindField(contentHash),
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
 * Move unrelated junk under denies/ into denies/quarantine/.
 * Skips quarantine/ and *.tmp.
 * Junk: non-.json or unsafe session names ONLY.
 * Well-named .json that fails validation stays in place so self-deny
 * remains fail-closed (spec: corrupt self ⇒ DENY; unrelated junk quarantined).
 * @returns {{ quarantined: string[], kept: string[], retainedForDeny: string[], ok: boolean, reason?: string }}
 */
export function quarantineJunkDenies(
  root,
  {
    fs = {
      mkdirSync,
      renameSync,
      existsSync,
      readdirSync,
      readFileSync,
    },
  } = {},
) {
  const dir = join(root, '.adlc', 'handoffs', 'denies');
  const quarantined = [];
  const kept = [];
  const retainedForDeny = [];
  if (!fs.existsSync(dir)) {
    return { ok: true, quarantined, kept, retainedForDeny };
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return {
      ok: false,
      reason: `readdir_failed:${err?.code || err?.message || 'error'}`,
      quarantined,
      kept,
      retainedForDeny,
    };
  }

  const qDir = join(dir, 'quarantine');
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const isDir = typeof entry === 'string' ? false : entry.isDirectory();
    if (name === 'quarantine' || isDir) continue;
    if (name.endsWith('.tmp')) continue;

    const full = join(dir, name);
    let junk = false;
    let reason = '';

    if (!name.endsWith('.json')) {
      junk = true;
      reason = 'non_json';
    } else {
      const sessionId = name.slice(0, -'.json'.length);
      try {
        assertSafeSessionId(sessionId);
      } catch {
        junk = true;
        reason = 'unsafe_session_id';
      }
      if (!junk) {
        const check = readDenyMarker(root, sessionId, { fs });
        if (!check.ok) {
          // Keep corrupt/mismatch self-named markers for fail-closed DENY.
          retainedForDeny.push(name);
          continue;
        }
      }
    }

    if (!junk) {
      kept.push(name);
      continue;
    }

    try {
      fs.mkdirSync(qDir, { recursive: true });
      const dest = join(qDir, `${name}.${reason || 'junk'}`);
      fs.renameSync(full, dest);
      quarantined.push(name);
    } catch {
      // fail-closed callers still treat unreadables as deny; skip move errors
    }
  }
  return { ok: true, quarantined, kept, retainedForDeny };
}

/**
 * Re-entry: if absolute handoff still applies and marker missing/bad → sticky deny.
 * Cooling does not clear open or consumed self-deny (D2 sticky).
 */
export function evaluateMarkerOnReentry(root, sessionId, { absoluteHandoff, fs } = {}) {
  assertSafeSessionId(sessionId);
  if (!absoluteHandoff) {
    const check = readDenyMarker(root, sessionId, { fs });
    if (check.ok && check.record?.status === 'open') {
      return { deny: true, processSticky: false, reason: 'open_deny_persists' };
    }
    if (check.ok && check.record?.status === 'consumed') {
      return { deny: true, processSticky: false, reason: 'consumed_deny_persists' };
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
