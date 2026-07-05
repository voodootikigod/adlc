// run.mjs — the whole ticket-prune operation as one pure-ish, testable
// function. bin/ticket-prune.mjs stays a thin arg-parse + exit-code shell
// around this (CONVENTIONS layout rule).

import { resolve } from 'node:path';
import { loadTickets } from '@adlc/core';
import { classifyTicket, classifyTickets, listTrackedFiles } from './detect.mjs';
import { acquireLock, releaseLock, readJson, writeJsonAtomic } from './store.mjs';

/**
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.ticketsPath] relative to cwd
 * @param {string} [options.archivePath] relative to cwd
 * @param {string} [options.baseRef] git ref to check scope/rails existence against
 * @param {boolean} [options.write] archive stale tickets instead of dry-run reporting
 * @returns {{ok: true, baseRef: string, write: boolean, stale: object[], active: object[], archived: object[]} | {ok: false, error: string}}
 */
export function runTicketPrune(options = {}) {
  const {
    cwd = process.cwd(),
    ticketsPath = '.adlc/tickets.json',
    archivePath = '.adlc/tickets.archive.json',
    baseRef = 'HEAD',
    write = false,
  } = options;

  // path.resolve (unlike path.join) treats an absolute ticketsPath/archivePath
  // as an override of cwd rather than concatenating onto it, so `--tickets
  // /abs/path.json` behaves the way users naturally expect.
  const absTicketsPath = resolve(cwd, ticketsPath);
  const absArchivePath = resolve(cwd, archivePath);

  const { tickets, errors } = loadTickets(absTicketsPath);
  if (errors.length) {
    return { ok: false, error: `ticket file errors:\n  ${errors.join('\n  ')}` };
  }

  if (tickets.length === 0) {
    return { ok: true, baseRef, write, stale: [], active: [], archived: [] };
  }

  let trackedFiles;
  try {
    trackedFiles = listTrackedFiles(baseRef, cwd);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const results = classifyTickets(tickets, trackedFiles);
  const stale = results.filter((r) => r.stale);
  const active = results.filter((r) => !r.stale);

  if (!write || stale.length === 0) {
    return { ok: true, baseRef, write, stale, active, archived: [] };
  }

  const locked = acquireLock(cwd);
  if (!locked) {
    return {
      ok: false,
      error: 'could not acquire .adlc/tickets.lock — another ADLC ticket writer is running',
    };
  }

  try {
    // Re-read under the lock: another writer (e.g. ticket-sync) may have
    // mutated tickets.json between the classification read above and here.
    // Every fallible step below (JSON parse of either file, either atomic
    // write) is wrapped so a failure surfaces as the documented
    // {ok:false, error} shape instead of an uncaught exception, and so a
    // failure never lands us in a state where a ticket vanishes from both
    // files (see the write ordering note below).
    let rawUnderLock;
    try {
      rawUnderLock = readJson(absTicketsPath, null);
    } catch (err) {
      return { ok: false, error: `could not re-read tickets file under lock: ${err.message}` };
    }
    if (rawUnderLock === null) {
      return { ok: false, error: `ticket file disappeared during archive: ${absTicketsPath}` };
    }
    const freshTickets = Array.isArray(rawUnderLock.tickets) ? rawUnderLock.tickets : [];

    const staleIds = new Set(stale.map((r) => r.id));
    const staleCandidates = freshTickets.filter((t) => staleIds.has(t.id));

    // Re-classify each candidate against the fresh content read under the
    // lock rather than trusting the pre-lock `stale`/reason data: another
    // writer (e.g. ticket-sync, or a human editor) may have mutated a
    // ticket's content between the initial classification and now in a way
    // that un-stales it (e.g. flipped `status` from "done" back to
    // "in-progress", or edited `scope`). Archiving on the stale
    // classification anyway would silently delete a currently-active ticket
    // and write an archive entry whose reason no longer matches its content.
    const freshReasonById = new Map();
    const removed = [];
    for (const ticket of staleCandidates) {
      const reclassified = classifyTicket(ticket, trackedFiles);
      if (reclassified.stale) {
        freshReasonById.set(ticket.id, reclassified.reason);
        removed.push(ticket);
      }
    }

    const removedIds = new Set(removed.map((t) => t.id));
    const kept = freshTickets.filter((t) => !removedIds.has(t.id));

    if (removed.length === 0) {
      // Every stale id was either already gone, or no longer classifies as
      // stale (a concurrent writer mutated it out from under us), by the
      // time we took the lock.
      return { ok: true, baseRef, write, stale, active, archived: [] };
    }

    const archivedAt = new Date().toISOString();
    let existingArchive;
    try {
      existingArchive = readJson(absArchivePath, { tickets: [] });
    } catch (err) {
      return { ok: false, error: `could not read archive file: ${err.message}` };
    }
    // readJson's fallback only applies to a genuinely absent file — a file
    // that exists and contains a syntactically-valid-but-unusable JSON
    // document (e.g. the literal `null`, a bare array, or `{}` without a
    // `tickets` array) parses successfully and is returned as-is. Guard
    // against that here (rather than trusting existingArchive.tickets to be
    // an array) so a pre-existing archive file with unexpected-but-valid
    // JSON content degrades to "treat as empty archive" instead of throwing
    // when we dereference .tickets below.
    const existingArchiveTickets =
      existingArchive && Array.isArray(existingArchive.tickets) ? existingArchive.tickets : [];
    const archiveById = new Map(existingArchiveTickets.map((t) => [t.id, t]));

    const archivedEntries = [];
    for (const ticket of removed) {
      const entry = { ...ticket, archivedAt, archiveReason: freshReasonById.get(ticket.id) };
      archiveById.set(ticket.id, entry);
      archivedEntries.push(entry);
    }

    // Write the archive BEFORE removing anything from tickets.json. If this
    // write throws (bad --archive directory, permissions, disk full), we
    // return an error with tickets.json completely untouched — the stale
    // tickets are still there to retry, never lost. The alternative
    // ordering (tickets.json first) can lose a ticket permanently if the
    // archive write is what fails, since it would already be gone from
    // tickets.json with nowhere else it was ever persisted.
    try {
      writeJsonAtomic(absArchivePath, { tickets: [...archiveById.values()] });
    } catch (err) {
      return { ok: false, error: `could not write archive file: ${err.message}` };
    }

    try {
      writeJsonAtomic(absTicketsPath, { ...rawUnderLock, tickets: kept });
    } catch (err) {
      // Worst case here: the archive now holds entries that are also still
      // present in tickets.json (a harmless duplicate, recoverable by
      // re-running), never a ticket that exists in neither file.
      return {
        ok: false,
        error: `archived ${archivedEntries.length} ticket(s) but failed to remove them from tickets.json: ${err.message}`,
      };
    }

    return { ok: true, baseRef, write, stale, active, archived: archivedEntries };
  } finally {
    releaseLock(cwd);
  }
}
