// The durable attempt ledger (spec §5.2, §13.0 `reset --attempts`; AC 59, 115,
// 118, 123, 134, 150; ticket AC5).
//
// `.adlc/autopilot-runs/<issue>.attempts.json` is a JSON array of
// `{ id, ts, kind, outcome }` — `id` a ULID minted when the entry is created
// and never changed, `outcome` `started` → `ok`|`failed`. An entry is appended
// (temp + rename) BEFORE the model call it names is spawned, so a crash between
// the write and the spawn leaves a `started` entry a fresh process counts as a
// failed attempt. Ordinary reads hide entries older than 7 days and NEVER touch
// the archive; `reset --attempts` is the journaled transaction of §13.0 that
// archives every raw entry (framed lines, each with its own sha256) before the
// ledger is truncated, so no attempt is ever lost between the two files.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync, constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { generateTicketId } from '@adlc/tickets';
import { lockHeldBy } from './lock.mjs';
import { writeAtomicJson } from './records.mjs';
import { active, registerSeams } from './mutations.mjs';

registerSeams([
  'attempts.ignoreStarted',       // a stuck `started` entry is not counted as a failure
  'attempts.resetWithoutLock',    // reset proceeds without the autopilot lock
  'attempts.pruneOnReset',        // reset archives only the entries an ordinary read would return
  'attempts.skipJournal',         // reset does not write its journal (a crash is not recoverable)
  'attempts.acceptTruncatedTail', // the archive reader keeps a tail line that lacks its newline
  'attempts.skipQuarantine',      // a complete line with a bad checksum is dropped silently
  'attempts.noArchive',           // reset truncates the ledger without archiving
]);

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_FAILED_ATTEMPTS = 3;
export const KINDS = Object.freeze(['shaping', 'coldstart']);
export const OUTCOMES = Object.freeze(['started', 'ok', 'failed']);

export class AttemptsError extends Error {
  constructor(code, detail, exitCode = 1) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.exitCode = exitCode; }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const iso = (ms) => new Date(ms).toISOString();

/** One framed archive line: the record with its own sha256, ending in `\n`. */
export function archiveLine(entry, archivedAt) {
  const record = sortKeys({ ...entry, archivedAt });
  delete record.sha256;
  return `${JSON.stringify({ ...record, sha256: sha256(JSON.stringify(record)) })}\n`;
}

/** Verify one COMPLETE line: parseable object, string id, checksum over the record minus `sha256`. */
export function verifyArchiveLine(line) {
  let rec;
  try { rec = JSON.parse(line); } catch (e) { return { ok: false, reason: `not JSON: ${e.message}` }; }
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec) || typeof rec.id !== 'string') return { ok: false, reason: 'not an archive record' };
  const { sha256: claimed, ...rest } = rec;
  if (typeof claimed !== 'string' || sha256(JSON.stringify(sortKeys(rest))) !== claimed) return { ok: false, reason: 'checksum mismatch' };
  return { ok: true, record: rec };
}

/**
 * Parse archive text: a trailing segment without `\n` is a crash artefact and
 * is discarded; a complete line that fails verification is an integrity failure.
 */
export function parseArchiveText(text) {
  const lines = String(text).split('\n');
  const tail = lines.pop();
  const truncatedTail = tail !== '';
  const records = []; const ids = new Set(); const validLines = []; const corrupt = [];
  lines.forEach((line, i) => {
    const v = verifyArchiveLine(line);
    if (v.ok) { records.push(v.record); ids.add(v.record.id); validLines.push(`${line}\n`); } else corrupt.push({ line: i + 1, reason: v.reason });
  });
  // Mutation seam `attempts.acceptTruncatedTail`: the partial tail counts as a record.
  if (truncatedTail && active('attempts.acceptTruncatedTail')) {
    try { const r = JSON.parse(tail); if (r && typeof r.id === 'string') { records.push(r); ids.add(r.id); validLines.push(`${tail}\n`); } } catch { /* unparseable tail stays discarded */ }
  }
  return { records, ids, validLines, corrupt, truncatedTail };
}

function writeAtomicText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Append framed lines with one O_APPEND write per line. `crashAfter` is the test-only crash injection point. */
function appendLines(path, lines, { crashAfter = null } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
  try {
    let written = 0;
    for (const line of lines) {
      writeSync(fd, line);
      written++;
      if (crashAfter === 'partial-archive' && written === 1 && lines.length > 1) throw new AttemptsError('crash-injected', 'after a partial archive append');
    }
    return written;
  } finally { closeSync(fd); }
}

/**
 * The per-issue ledger store. `paths` = autopilotPaths(repoRoot); `now` epoch ms;
 * `lockToken` the autopilot lock token `reset` verifies against `paths.adlc`.
 */
export function createAttemptStore({ paths, now = Date.now, lockToken = null, ulid = generateTicketId }) {
  const readRaw = (n) => {
    const p = paths.attempts(n);
    if (!existsSync(p)) return [];
    let arr;
    try { arr = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new AttemptsError('attempts-corrupt', `${p}: ${e.message}`); }
    if (!Array.isArray(arr) || !arr.every((e) => e && typeof e === 'object' && typeof e.id === 'string')) throw new AttemptsError('attempts-corrupt', `${p}: not an array of entries`);
    return arr;
  };
  const writeLedger = (n, entries) => writeAtomicJson(paths.attempts(n), entries);

  /** Read the archive; quarantine + rebuild on a corrupt COMPLETE line, trim a truncated tail. */
  const readArchive = (n) => {
    const p = paths.attemptsArchive(n);
    const events = [];
    if (!existsSync(p)) return { records: [], ids: new Set(), events };
    const parsed = parseArchiveText(readFileSync(p, 'utf8'));
    if (parsed.corrupt.length) {
      // Mutation seam `attempts.skipQuarantine`: the bad line is dropped without a trace.
      if (!active('attempts.skipQuarantine')) {
        renameSync(p, `${p}.corrupt-${iso(now()).replace(/[:.]/g, '-')}`);
        writeAtomicText(p, parsed.validLines.join(''));
        events.push('archive-corrupt');
      }
    } else if (parsed.truncatedTail && !active('attempts.acceptTruncatedTail')) {
      writeAtomicText(p, parsed.validLines.join(''));
      events.push('archive-truncated-tail');
    }
    return { records: parsed.records, ids: parsed.ids, events };
  };

  /** Steps 2–4 of §13.0 over the RAW entries: archive by id, truncate, drop the journal. */
  const replay = (n, entries, { crashAfter = null } = {}) => {
    const arch = readArchive(n);
    const t = now();
    // Mutation seam `attempts.pruneOnReset`: the archive only receives what an ordinary read shows.
    let pending = active('attempts.pruneOnReset') ? entries.filter((e) => Date.parse(e.ts) >= t - RETENTION_MS) : entries;
    const seen = new Set(arch.ids);
    pending = pending.filter((e) => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
    // Mutation seam `attempts.noArchive`: the ledger is truncated without an archive append.
    const lines = active('attempts.noArchive') ? [] : pending.map((e) => archiveLine(e, iso(t)));
    const archived = lines.length ? appendLines(paths.attemptsArchive(n), lines, { crashAfter }) : 0;
    writeLedger(n, []);
    const j = paths.attemptsJournal(n);
    if (existsSync(j)) unlinkSync(j);
    return { archived, events: arch.events };
  };

  /** Complete a pending reset journal before any other ledger operation (§13.0). */
  const recoverAttempts = (n) => {
    const j = paths.attemptsJournal(n);
    if (!existsSync(j)) return { recovered: false, archived: 0, events: [] };
    const r = replay(n, readRaw(n));
    return { recovered: true, ...r };
  };

  const readAttempts = (n, { now: t = now() } = {}) => {
    recoverAttempts(n);
    return readRaw(n).filter((e) => Date.parse(e.ts) >= t - RETENTION_MS);
  };

  const beginAttempt = (n, kind) => {
    if (!KINDS.includes(kind)) throw new AttemptsError('bad-input:kind', String(kind));
    recoverAttempts(n);
    const t = now();
    const entry = { id: ulid(t), ts: iso(t), kind, outcome: 'started' };
    writeLedger(n, [...readRaw(n), entry]);
    return entry;
  };

  const finishAttempt = (n, id, outcome) => {
    if (outcome !== 'ok' && outcome !== 'failed') throw new AttemptsError('bad-input:outcome', String(outcome));
    recoverAttempts(n);
    const entries = readRaw(n);
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) throw new AttemptsError('attempt-missing', id);
    const updated = { ...entries[idx], outcome, finishedAt: iso(now()) };
    writeLedger(n, entries.map((e, i) => (i === idx ? updated : e)));
    return updated;
  };

  /** Failed attempts in the trailing 24 h: `failed` plus stuck `started` (a crash between write and spawn). */
  const failedWithin24h = (n, { kind = 'shaping', now: t = now() } = {}) => readAttempts(n, { now: t })
    .filter((e) => e.kind === kind && Date.parse(e.ts) >= t - WINDOW_MS)
    // Mutation seam `attempts.ignoreStarted`.
    .filter((e) => e.outcome === 'failed' || (e.outcome === 'started' && !active('attempts.ignoreStarted'))).length;

  const shapingExcluded = (n, opts) => failedWithin24h(n, opts) >= MAX_FAILED_ATTEMPTS;

  /** §13.0 `reset --attempts`: journaled, idempotent, refused without the lock, touches nothing else. */
  const resetAttempts = (n, { lockToken: tok = lockToken, crashAfter = null } = {}) => {
    // Mutation seam `attempts.resetWithoutLock`.
    if (!active('attempts.resetWithoutLock') && !(tok && lockHeldBy(paths.adlc, tok))) throw new AttemptsError('lock-required', 'reset --attempts runs only under the autopilot lock');
    const pending = recoverAttempts(n);
    const p = paths.attempts(n);
    const rawText = existsSync(p) ? readFileSync(p, 'utf8') : '[]';
    const entries = readRaw(n);
    // Mutation seam `attempts.skipJournal`.
    if (!active('attempts.skipJournal')) writeAtomicJson(paths.attemptsJournal(n), { startedAt: iso(now()), ledgerSha256: sha256(rawText) });
    const r = replay(n, entries, { crashAfter });
    return { archived: r.archived, cleared: entries.length, events: [...pending.events, ...r.events], recoveredPending: pending.recovered };
  };

  const archivedAttempts = (n) => readArchive(n);

  return { readRaw, readAttempts, beginAttempt, finishAttempt, failedWithin24h, shapingExcluded, resetAttempts, recoverAttempts, archivedAttempts };
}
