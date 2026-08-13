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
import { closeSync, fstatSync, openSync, readSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { loadTickets } from '@adlc/core';
import { loadFiltered } from '@adlc/gate-manifest/lib/show.mjs';

/** Manifest entries carried into the brief. */
export const EVIDENCE_TAIL_ENTRIES = 12;

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
 * @param {string} adlcDir absolute `.adlc` directory
 * @returns {string[]}
 */
export function evidenceTail(adlcDir, { limit = EVIDENCE_TAIL_ENTRIES } = {}) {
  let entries;
  try {
    entries = loadFiltered({ dir: adlcDir }).entries;
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  return entries
    .slice(-limit)
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
 * @returns {{ ok: true, text: string, truncated: boolean } | { ok: false, error: string }}
 */
export function readTranscriptTail(path, { maxBytes = TRANSCRIPT_TAIL_BYTES } = {}) {
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
    if (start === 0) return { ok: true, text, truncated: false };
    const firstBreak = text.indexOf('\n');
    return { ok: true, text: firstBreak === -1 ? '' : text.slice(firstBreak + 1), truncated: true };
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
