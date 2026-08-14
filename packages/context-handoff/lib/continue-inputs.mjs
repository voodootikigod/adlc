/**
 * Host-side gathering for the continuation brief.
 *
 * `composeBrief` is pure; this is the half that touches the world — git, the
 * gate manifest, the ticket store. Every reader is best-effort and returns the
 * empty answer rather than throwing: a brief missing its git section is worth
 * far more to a successor than a continuation that aborted because the repo has
 * no commits yet. Nothing here is a gate, so nothing here fails closed.
 */

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  constants as fsConstants,
} from 'node:fs';
import { join } from 'node:path';
import { loadTickets } from '@adlc/core';

/** Manifest entries carried into the brief. */
export const EVIDENCE_TAIL_ENTRIES = 12;

/** Bytes read from the tail of the newest manifest chain. */
export const EVIDENCE_TAIL_BYTES = 64 * 1024;

/**
 * The newest manifest chain to read entries from: the highest-sorting segment
 * under `manifest.d/` (segment names end in a ULID, which sorts by creation
 * time), or the root ledger when the repo has no segments.
 *
 * @param {string} adlcDir
 * @returns {string|null} path, or null when there is no ledger at all
 */
export function newestManifestChain(adlcDir) {
  const segmentDir = join(adlcDir, 'manifest.d');
  try {
    const segments = readdirSync(segmentDir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
    if (segments.length > 0) return join(segmentDir, segments[segments.length - 1]);
  } catch {
    // No segment directory — a pre-forest repo, or one that has never split.
  }
  const root = join(adlcDir, 'manifest.jsonl');
  return existsSync(root) ? root : null;
}

/** Working-tree lines carried into the brief before it summarizes the rest. */
export const GIT_STATUS_MAX_LINES = 40;

/**
 * Transcript bytes read from the END of the file. A session transcript grows
 * without bound and the final assistant message is at its tail, so the whole
 * file is never worth slurping — and a host process holding the manifest key
 * must not be the thing a huge file can exhaust.
 */
export const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

/** Fixed argv, no shell: nothing here interpolates caller-supplied text. */
function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
  } catch {
    return null;
  }
}

/**
 * Branch name and a bounded porcelain status.
 * @returns {{ branch: string|null, status: string[] }}
 */
export function gitState(root, { run = git } = {}) {
  const branch = run(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = run(root, ['status', '--porcelain']);
  const lines = typeof porcelain === 'string'
    ? porcelain.split('\n').filter((line) => line.trim().length > 0)
    : [];
  const status = lines.slice(0, GIT_STATUS_MAX_LINES);
  if (lines.length > status.length) {
    status.push(`… ${lines.length - status.length} more changed path(s)`);
  }
  return { branch: typeof branch === 'string' ? branch.trim() || null : null, status };
}

/**
 * The last few gate-manifest entries, one line each.
 *
 * BOUNDED BEFORE PARSING. The forest read (`readManifestForest`) parses every
 * line of the root ledger and every segment to hand back a fully ordered
 * history — for a dozen display lines in a brief. That cost grows without limit
 * with the repo's history, and it makes a brief's content depend on files this
 * command has no reason to read. So this reads the NEWEST chain only, from its
 * tail, with a byte cap.
 *
 * The trade is deliberate and it is a real one: if the newest segment holds
 * fewer than `limit` entries, the brief carries fewer rather than reaching back
 * into older segments. A short evidence tail costs a successor a little
 * context; an unbounded read costs every continuation the whole ledger.
 *
 * @param {string} adlcDir absolute `.adlc` directory
 * @returns {string[]}
 */
export function evidenceTail(adlcDir, { limit = EVIDENCE_TAIL_ENTRIES } = {}) {
  const path = newestManifestChain(adlcDir);
  if (path === null) return [];
  const tail = readFileTail(path, { maxBytes: EVIDENCE_TAIL_BYTES });
  if (!tail.ok) return [];
  const lines = [];
  for (const line of tail.text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) lines.push(entry);
    } catch {
      // A half-flushed or clipped line is skipped, never guessed at.
    }
  }
  // Not `slice(-limit)`: a limit of 0 negates to -0, which slices from the
  // start and hands back the whole chain — the opposite of the bound asked for.
  return lines
    .slice(Math.max(0, lines.length - Math.max(0, limit)))
    .map((e) => `seq=${e.seq} gate=${e.gate} ts=${e.ts}${e.ticket ? ` ticket=${e.ticket}` : ''}`);
}

/**
 * Read the tail of a transcript file.
 *
 * Opened O_NONBLOCK and type-checked on the fd, the same posture the active
 * ticket pointer uses: the path arrives as an operator flag and a FIFO there
 * would otherwise hang the CLI while it holds the denier's lock. A tail that
 * starts mid-line drops that partial line rather than handing a truncated JSON
 * object to the parser.
 *
 * @returns {{ ok: true, text: string, truncated: boolean, mtimeMs: number }
 *          | { ok: false, error: string }}
 */
export function readFileTail(path, { maxBytes = TRANSCRIPT_TAIL_BYTES } = {}) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (err) {
    return { ok: false, error: err?.code || err?.message || 'unreadable' };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, error: 'not_a_file' };
    const length = Math.min(stat.size, maxBytes);
    const start = stat.size - length;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    // POSIX read(2) may return fewer bytes than asked for; loop to the end.
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    const text = buf.toString('utf8', 0, read);
    const mtimeMs = stat.mtimeMs;
    if (start === 0) return { ok: true, text, truncated: false, mtimeMs };
    const firstBreak = text.indexOf('\n');
    return {
      ok: true,
      text: firstBreak === -1 ? '' : text.slice(firstBreak + 1),
      truncated: true,
      mtimeMs,
    };
  } catch (err) {
    return { ok: false, error: err?.code || err?.message || 'unreadable' };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best-effort: a throwing close must not break the never-throw contract
    }
  }
}

/**
 * Bounded tail read of a harness transcript. Named for its caller because the
 * transcript is the one whose size is genuinely unbounded.
 * @returns {{ ok: true, text: string, truncated: boolean, mtimeMs: number }
 *          | { ok: false, error: string }}
 */
export function readTranscriptTail(path, opts = {}) {
  return readFileTail(path, opts);
}

/**
 * Title of a ticket in the store, when it can be read.
 * @returns {string|null}
 */
export function ticketTitle(adlcDir, ticketId) {
  if (typeof ticketId !== 'string' || ticketId.length === 0) return null;
  try {
    const { tickets } = loadTickets(join(adlcDir, 'tickets.json'));
    const found = tickets.find((t) => t.id === ticketId);
    return typeof found?.title === 'string' ? found.title : null;
  } catch {
    return null;
  }
}
