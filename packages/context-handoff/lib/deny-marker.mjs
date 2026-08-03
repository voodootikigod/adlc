import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, basename } from 'node:path';

/**
 * Process-unique temp sibling for atomic write-then-rename.
 * Avoids fixed `${final}.tmp` collisions across concurrent writers.
 * @param {string} finalPath
 * @returns {string}
 */
function uniqueTmpPath(finalPath) {
  return `${finalPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
}

/** Best-effort cleanup of a unique tmp left behind after write/rename failure. */
function tryUnlinkTmp(tmp, fs) {
  if (!tmp) return;
  try {
    if (typeof fs.unlinkSync === 'function') fs.unlinkSync(tmp);
  } catch {
    // best-effort
  }
}

/**
 * Fail-closed deny marker helpers. Injectable fs for tests.
 */

/**
 * Non-throwing session-id safety predicate shared with the mutation gate.
 * Rejects empty / padded / path-separators / `..` / basename mismatch so deny
 * paths cannot escape `.adlc/handoffs/denies/`.
 * @param {unknown} sessionId
 * @returns {boolean}
 */
export function isSafeSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  if (sessionId.trim().length === 0 || sessionId.trim() !== sessionId) return false;
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
    return false;
  }
  if (basename(sessionId) !== sessionId) return false;
  return true;
}

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

const QUARANTINE_BEFORE_WRITE = new Set(['corrupt_json', 'invalid_shape']);

/**
 * Quarantine an existing marker's bytes before rewriting.
 * Destination: denies/quarantine/<name>.<reason>.<ts>
 * @returns {boolean} true if quarantine succeeded (or file already gone)
 */
function uniqueQuarantineDest(qDir, name, reason, fs) {
  const base = `${name}.${reason || 'junk'}.${Date.now()}`;
  let dest = join(qDir, base);
  let n = 0;
  // Cap attempts so a pathological existsSync(true) cannot spin forever.
  while (n < 1000 && fs.existsSync(dest)) {
    n += 1;
    dest = join(qDir, `${base}.${n}`);
  }
  return dest;
}

function quarantineExistingMarker(path, reason, fs) {
  if (!fs.existsSync(path)) return true;
  const dir = dirname(path);
  const qDir = join(dir, 'quarantine');
  const name = basename(path);
  try {
    fs.mkdirSync(qDir, { recursive: true });
    const dest = uniqueQuarantineDest(qDir, name, reason, fs);
    fs.renameSync(path, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure marker exists; on failure return processSticky recommendation.
 * Idempotent: never rewrite an already-valid open or consumed marker
 * (preserves host-repaired ticket_id/content_hash and consumed status).
 * Unreadable existing markers fail closed without clobber.
 * session_id_mismatch: refuse overwrite (another session's durable state).
 * Other invalid states: quarantine-before-write, then write fresh open.
 * @returns {{ ok: boolean, processSticky: boolean, reason: string }}
 */
export function ensureDenyMarker(
  root,
  { sessionId, ticketId = null, contentHash = null, host = 'local' },
  {
    fs = { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync, unlinkSync },
    now = () => new Date().toISOString(),
  } = {},
) {
  assertSafeSessionId(sessionId);
  const existing = readDenyMarker(root, sessionId, { fs });
  if (existing.ok) {
    if (!ensureDenyStoreSentinel(root, fs, sessionId)) {
      return { ok: false, processSticky: true, reason: 'sentinel_write_failed' };
    }
    return { ok: true, processSticky: false, reason: 'already_present' };
  }
  // Exists but unreadable: never clobber durable state.
  if (existing.reason === 'unreadable_marker') {
    return { ok: false, processSticky: true, reason: 'unreadable_marker' };
  }
  // Foreign session's durable state under this path — never overwrite.
  if (existing.reason === 'session_id_mismatch') {
    return { ok: false, processSticky: true, reason: 'session_id_mismatch' };
  }
  // Unrecognized status may still carry host-repaired binds — fail closed, no rewrite.
  if (existing.reason === 'invalid_status') {
    return { ok: false, processSticky: true, reason: 'invalid_status' };
  }

  const path = denyPath(root, sessionId);
  // Corrupt / invalid existing file: quarantine bytes, then write fresh open.
  if (QUARANTINE_BEFORE_WRITE.has(existing.reason) && fs.existsSync(path)) {
    if (!quarantineExistingMarker(path, existing.reason, fs)) {
      return { ok: false, processSticky: true, reason: `quarantine_failed:${existing.reason}` };
    }
  }

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
  const tmp = uniqueTmpPath(path);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, path);
  } catch (err) {
    tryUnlinkTmp(tmp, fs);
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
  // Sentinel only after the marker is verified — avoids bricking the repo on
  // a partial write (sentinel with empty denies/). Register this session so a
  // later selective delete of the marker cannot clear D2 while others remain.
  if (!ensureDenyStoreSentinel(root, fs, sessionId)) {
    return { ok: false, processSticky: true, reason: 'sentinel_write_failed' };
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
  const failed = [];
  let lastFail = '';
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
      const dest = uniqueQuarantineDest(qDir, name, reason || 'junk', fs);
      fs.renameSync(full, dest);
      quarantined.push(name);
    } catch (err) {
      failed.push(name);
      lastFail = `quarantine_failed:${err?.code || err?.message || 'error'}`;
    }
  }
  if (failed.length > 0) {
    return { ok: false, reason: lastFail, quarantined, kept, retainedForDeny, failed };
  }
  return { ok: true, quarantined, kept, retainedForDeny };
}

/**
 * Re-entry: if absolute handoff still applies and marker missing/bad → sticky deny.
 * Cooling does not clear open or consumed self-deny (D2 sticky).
 */

/**
 * Enumerate denies/*.json into gate-ready records + invalid retained entries.
 * Junk filenames are skipped (call quarantineJunkDenies separately).
 * Unparseable / invalid self-named markers surface as invalidRecords so the
 * gate can fail closed (D3:invalid_record) rather than silently drop them.
 * @returns {{ ok: boolean, records: object[], invalidRecords: object[], reason?: string }}
 */
/** Durable deny-store sentinel — sibling of handoffs/, not inside it. */
function denyStoreSentinelPath(root) {
  return join(root, '.adlc', '.deny-store');
}

/** Pre-slice migration path (inside handoffs/); still honored and self-healed. */
function legacyDenyStoreSentinelPath(root) {
  return join(root, '.adlc', 'handoffs', '.deny-store');
}

/**
 * Read sentinel. Shape: {"schema":1,"sessions":["id",...]} or legacy "1\n".
 * @returns {{ expected: boolean, sessions: string[] }}
 */
function readDenyStoreSentinel(root, fs) {
  const path = denyStoreSentinelPath(root);
  const legacy = legacyDenyStoreSentinelPath(root);
  let raw = null;
  let fromLegacy = false;
  if (fs.existsSync(path)) {
    try {
      raw = fs.readFileSync(path, 'utf8');
    } catch {
      // Unreadable sentinel ⇒ expected (fail closed) with unknown session set.
      return { expected: true, sessions: [] };
    }
  } else if (fs.existsSync(legacy)) {
    fromLegacy = true;
    try {
      raw = fs.readFileSync(legacy, 'utf8');
    } catch {
      return { expected: true, sessions: [] };
    }
  } else {
    return { expected: false, sessions: [] };
  }
  const trimmed = String(raw).trim();
  if (trimmed === '1' || trimmed === '') {
    return { expected: true, sessions: [], legacy: fromLegacy };
  }
  try {
    const parsed = JSON.parse(trimmed);
    const sessions = Array.isArray(parsed?.sessions)
      ? parsed.sessions.filter((s) => typeof s === 'string' && isSafeSessionId(s))
      : [];
    return { expected: true, sessions, legacy: fromLegacy };
  } catch {
    // Corrupt sentinel still means the store was initialized.
    return { expected: true, sessions: [] };
  }
}

/**
 * Persist sentinel, optionally registering sessionId in the denied-session set.
 * @returns {boolean}
 */
function ensureDenyStoreSentinel(root, fs, sessionId = null) {
  const adlcDir = join(root, '.adlc');
  const sentinel = denyStoreSentinelPath(root);
  let tmp = null;
  try {
    fs.mkdirSync(adlcDir, { recursive: true });
    const cur = readDenyStoreSentinel(root, fs);
    const set = new Set(cur.sessions);
    if (typeof sessionId === 'string' && isSafeSessionId(sessionId)) {
      set.add(sessionId);
    }
    const next = [...set].sort();
    // Skip rewrite when membership unchanged and new-format sentinel already present.
    if (
      cur.expected &&
      !cur.legacy &&
      next.length === cur.sessions.length &&
      next.every((s, i) => s === [...cur.sessions].sort()[i]) &&
      fs.existsSync(sentinel)
    ) {
      return true;
    }
    const body = `${JSON.stringify({ schema: 1, sessions: next })}\n`;
    tmp = uniqueTmpPath(sentinel);
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, sentinel);
    return true;
  } catch {
    tryUnlinkTmp(tmp, fs);
    return false;
  }
}

function denyStoreExpectedBySentinel(root, fs) {
  return readDenyStoreSentinel(root, fs).expected;
}

function sessionRegisteredInDenyStore(root, fs, sessionId) {
  if (!isSafeSessionId(sessionId)) return false;
  return readDenyStoreSentinel(root, fs).sessions.includes(sessionId);
}

export function loadDenyRecords(
  root,
  {
    fs = {
      existsSync,
      readdirSync,
      readFileSync,
      mkdirSync,
      writeFileSync,
      renameSync,
      unlinkSync,
    },
    /**
     * When true, a missing/emptied denies/ directory is unavailable — not a clean store.
     * Default: auto — expected only when `.adlc/.deny-store` exists
     * (written by ensureDenyMarker; legacy `.adlc/handoffs/.deny-store` migrates).
     * Pass false for known-fresh trees.
     */
    storeExpected,
  } = {},
) {
  const dir = join(root, '.adlc', 'handoffs', 'denies');
  const records = [];
  const invalidRecords = [];
  const sentinelInfo = readDenyStoreSentinel(root, fs);
  if (sentinelInfo.expected && sentinelInfo.legacy) {
    ensureDenyStoreSentinel(root, fs);
  }
  const registeredSessions = readDenyStoreSentinel(root, fs).sessions;
  let expected;
  if (storeExpected === undefined || storeExpected === null) {
    expected = sentinelInfo.expected;
  } else if (storeExpected === true) {
    expected = true;
  } else if (storeExpected === false) {
    expected = false;
  } else {
    // Non-boolean → fail closed (treat store as expected).
    expected = true;
  }
  if (!fs.existsSync(dir)) {
    if (expected) {
      invalidRecords.push({
        session_id: '__deny_store__',
        status: 'invalid:missing_deny_store',
        ticket_id: null,
        content_hash: null,
      });
      return {
        ok: false,
        reason: 'missing_deny_store',
        records,
        invalidRecords,
        registeredSessions,
        denyStoreUnavailable: true,
      };
    }
    return { ok: true, records, invalidRecords, registeredSessions, denyStoreUnavailable: false };
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Sentinel so spread-into-gate patterns fail closed even if ok is ignored.
    invalidRecords.push({
      session_id: '__deny_store__',
      status: 'invalid:readdir_failed',
      ticket_id: null,
      content_hash: null,
    });
    return {
      ok: false,
      reason: `readdir_failed:${err?.code || err?.message || 'error'}`,
      records,
      invalidRecords,
      registeredSessions,
      denyStoreUnavailable: true,
    };
  }
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const isDir = typeof entry === 'string' ? false : entry.isDirectory();
    if (name === 'quarantine' || isDir) continue;
    if (name.endsWith('.tmp')) continue;
    if (!name.endsWith('.json')) continue;
    const sessionId = name.slice(0, -'.json'.length);
    if (!isSafeSessionId(sessionId)) continue;
    const check = readDenyMarker(root, sessionId, { fs });
    if (check.ok && check.record) {
      records.push(check.record);
      continue;
    }
    if (check.reason === 'missing_marker') continue;
    invalidRecords.push({
      session_id: sessionId,
      status: `invalid:${check.reason}`,
      ticket_id: null,
      content_hash: null,
    });
  }
  // Self-heal once if valid markers exist but sentinel membership is missing them.
  if (records.length > 0) {
    const need = records.map((r) => r.session_id).filter((id) => !registeredSessions.includes(id));
    if (need.length > 0 || !fs.existsSync(denyStoreSentinelPath(root))) {
      for (const id of records.map((r) => r.session_id)) {
        ensureDenyStoreSentinel(root, fs, id);
      }
      registeredSessions.splice(
        0,
        registeredSessions.length,
        ...readDenyStoreSentinel(root, fs).sessions,
      );
    }
  }

  // Sentinel present but no marker files left → store was wiped in place.
  if (expected && records.length === 0 && invalidRecords.length === 0) {
    invalidRecords.push({
      session_id: '__deny_store__',
      status: 'invalid:emptied_deny_store',
      ticket_id: null,
      content_hash: null,
    });
    return {
      ok: false,
      reason: 'emptied_deny_store',
      records,
      invalidRecords,
      registeredSessions,
      denyStoreUnavailable: true,
    };
  }

  // Registered sessions with no on-disk marker: selective delete must not clear D3
  // for other sessions (consumed markers alone must not hide a deleted open deny).
  for (const sid of registeredSessions) {
    const present =
      records.some((r) => r.session_id === sid) ||
      invalidRecords.some((r) => r.session_id === sid);
    if (!present) {
      invalidRecords.push({
        session_id: sid,
        status: 'invalid:missing_registered_marker',
        ticket_id: null,
        content_hash: null,
      });
    }
  }

  return { ok: true, records, invalidRecords, registeredSessions, denyStoreUnavailable: false };

}


/**
 * Compose loadDenyRecords output into evaluateMutationGate input.
 * Prefer this over hand-spreading records so store-health cannot be dropped.
 */
export function mutationGateInputFromLoad(
  loaded,
  {
    currentSessionId,
    processStickyDeny = false,
    resumeAuth = null,
    bypassForSession = false,
    manifestVerifyFailed = false,
  } = {},
) {
  // Fail closed on anything that is not a well-formed loadDenyRecords result.
  const wellFormed =
    loaded != null &&
    typeof loaded === 'object' &&
    Array.isArray(loaded.records) &&
    Array.isArray(loaded.invalidRecords) &&
    typeof loaded.ok === 'boolean';
  const records = wellFormed ? loaded.records : [];
  // Store-health synthetics (__deny_store__) are carried by denyStoreUnavailable
  // alone — duplicating them into denyRecords makes D0 unclearable via D3.
  const invalid = wellFormed
    ? loaded.invalidRecords.filter((r) => r?.session_id !== '__deny_store__')
    : [];
  const unavailable =
    !wellFormed ||
    loaded.ok === false ||
    loaded.denyStoreUnavailable === true;
  const registered = wellFormed && Array.isArray(loaded.registeredSessions)
    ? loaded.registeredSessions
    : [];
  const hasSelf = [...records, ...invalid].some(
    (r) => r && r.session_id === currentSessionId,
  );
  const sticky =
    processStickyDeny ||
    (typeof currentSessionId === 'string' &&
      registered.includes(currentSessionId) &&
      !hasSelf);
  return {
    currentSessionId,
    denyRecords: [...records, ...invalid],
    processStickyDeny: sticky,
    resumeAuth,
    bypassForSession,
    manifestVerifyFailed,
    denyStoreUnavailable: unavailable,
  };
}

export function evaluateMarkerOnReentry(
  root,
  sessionId,
  { absoluteHandoff, fs, denyEverWritten = false } = {},
) {
  assertSafeSessionId(sessionId);
  // Normalize once so sentinel probes and marker reads share one fs view.
  const io = fs ?? { existsSync, readFileSync };
  // Strict boolean — omitted/string/null fail closed as handoff-active.
  if (typeof absoluteHandoff !== 'boolean') {
    return {
      deny: true,
      processSticky: true,
      reason: 'invalid_handoff_signal',
      retryWrite: true,
    };
  }
  if (!absoluteHandoff) {
    const check = readDenyMarker(root, sessionId, { fs: io });
    if (check.ok && check.record?.status === 'open') {
      return { deny: true, processSticky: false, reason: 'open_deny_persists' };
    }
    if (check.ok && check.record?.status === 'consumed') {
      return { deny: true, processSticky: false, reason: 'consumed_deny_persists' };
    }
    if (!check.ok && check.reason === 'missing_marker') {
      // Per-session fact: denyEverWritten OR session registered in sentinel.
      // Repo-global sentinel presence alone must not sticky-deny strangers.
      if (denyEverWritten || sessionRegisteredInDenyStore(root, io, sessionId)) {
        return { deny: true, processSticky: true, reason: 'marker_vanished' };
      }
      return { deny: false, processSticky: false, reason: 'no_handoff_no_marker' };
    }
    if (!check.ok) return { deny: true, processSticky: true, reason: check.reason };
    return { deny: false, processSticky: false, reason: 'ok' };
  }
  const check = readDenyMarker(root, sessionId, { fs: io });
  if (!check.ok) {
    return { deny: true, processSticky: true, reason: check.reason, retryWrite: true };
  }
  return { deny: true, processSticky: false, reason: 'handoff_active' };
}
