// run.mjs — the whole ticket-prune operation as one pure-ish, testable
// function. bin/ticket-prune.mjs stays a thin arg-parse + exit-code shell
// around this (CONVENTIONS layout rule).

import { join } from 'node:path';
import { loadTickets } from '@adlc/core';
import { classifyTickets, listTrackedFiles } from './detect.mjs';
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

  const absTicketsPath = join(cwd, ticketsPath);
  const absArchivePath = join(cwd, archivePath);

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
    const rawUnderLock = readJson(absTicketsPath, null);
    if (rawUnderLock === null) {
      return { ok: false, error: `ticket file disappeared during archive: ${absTicketsPath}` };
    }
    const freshTickets = Array.isArray(rawUnderLock.tickets) ? rawUnderLock.tickets : [];

    const staleIds = new Set(stale.map((r) => r.id));
    const kept = freshTickets.filter((t) => !staleIds.has(t.id));
    const removed = freshTickets.filter((t) => staleIds.has(t.id));

    if (removed.length === 0) {
      // Every stale id was already gone by the time we took the lock.
      return { ok: true, baseRef, write, stale, active, archived: [] };
    }

    const archivedAt = new Date().toISOString();
    const reasonById = new Map(stale.map((r) => [r.id, r.reason]));
    const existingArchive = readJson(absArchivePath, { tickets: [] });
    const archiveById = new Map((existingArchive.tickets ?? []).map((t) => [t.id, t]));

    const archivedEntries = [];
    for (const ticket of removed) {
      const entry = { ...ticket, archivedAt, archiveReason: reasonById.get(ticket.id) };
      archiveById.set(ticket.id, entry);
      archivedEntries.push(entry);
    }

    writeJsonAtomic(absTicketsPath, { ...rawUnderLock, tickets: kept });
    writeJsonAtomic(absArchivePath, { tickets: [...archiveById.values()] });

    return { ok: true, baseRef, write, stale, active, archived: archivedEntries };
  } finally {
    releaseLock(cwd);
  }
}
