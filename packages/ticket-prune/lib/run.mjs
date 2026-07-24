// run.mjs — the whole ticket-prune operation as one pure-ish, testable
// function. bin/ticket-prune.mjs stays a thin arg-parse + exit-code shell
// around this (CONVENTIONS layout rule).

import { resolve } from 'node:path';
import { loadTickets } from '@adlc/core';
import { classifyTicket, classifyTickets, ceremonyDisposition, listTrackedFiles } from './detect.mjs';
import { acquireLock, releaseLock, readJson, writeJsonAtomic } from './store.mjs';
import { orderArchiveCandidates } from './archive-order.mjs';
import { DirectoryTicketStore, archiveTicket, detectTicketStore } from '@adlc/tickets';

/**
 * Compute the needsCeremony report from the pre-lock classification. Shared by
 * the dry-run early return and (as the visibility baseline) the write path, so
 * dry-run surfaces exactly the set a ceremony would act on (#198 AC1).
 * @returns {{id: string, reason: string, rails: string[], blocker: 'rails-freeze' | 'preexisting-completed-field'}[]}
 */
function computeNeedsCeremony(stale, ticketsById) {
  const out = [];
  for (const item of stale) {
    const ticket = ticketsById.get(item.id);
    if (!ticket) continue;
    const disposition = ceremonyDisposition(ticket, item.reason);
    if (disposition.disposition === 'ceremony') out.push(disposition.entry);
  }
  return out;
}

/**
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.ticketsPath] relative to cwd
 * @param {string} [options.baseRef] git ref to check scope/rails existence against
 * @param {boolean} [options.write] tombstone rails-less stale tickets in place instead of dry-run reporting
 * @param {boolean} [options.ceremony] protected-base admin action: also complete rail-freezing stale
 *   tickets in place (expires their rails, T36). Requires ADLC_RAILS_BYPASS=1 and writes nothing without it.
 * @returns {{ok: true, baseRef: string, write: boolean, ceremony: boolean, stale: object[], active: object[], tombstoned: {id: string, reason: string}[], ceremonyCompleted: {id: string, reason: string, rails: string[]}[], needsCeremony: {id: string, reason: string, rails: string[], blocker: 'rails-freeze' | 'preexisting-completed-field'}[]} | {ok: false, error: string}}
 */
export function runTicketPrune(options = {}) {
  const {
    cwd = process.cwd(),
    ticketsPath = '.adlc/tickets.json',
    baseRef = 'HEAD',
    write = false,
    ceremony = false,
  } = options;

  // `--ceremony` is DEPRECATED (#208). It was a bulk completion: it took no
  // ticket ids and recomputed its target set at run time (a TOCTOU window and no
  // per-ticket filter), wrote tickets.json directly via writeJsonAtomic without
  // recording manifest evidence, and had no directory-store implementation. The
  // canonical per-ticket path fixes all of that. Fail closed with a redirect,
  // FIRST, before any read — so any already-shipped instruction that still calls
  // `--ceremony` gets pointed at the safe command instead of silently mutating.
  if (ceremony) {
    return {
      ok: false,
      error:
        'ticket-prune --ceremony is deprecated (#208): it was a bulk, evidence-less, ' +
        'legacy-store-only completion. Complete each reviewed ticket individually with ' +
        '`adlc ticket complete <id> --write --authorize --json` — per-ticket (no TOCTOU), ' +
        'records manifest evidence, and works on both the legacy and directory stores.',
    };
  }

  // path.resolve (unlike path.join) treats an absolute ticketsPath as an
  // override of cwd rather than concatenating onto it, so `--tickets
  // /abs/path.json` behaves the way users naturally expect.
  const absTicketsPath = resolve(cwd, ticketsPath);

  const { tickets, errors } = loadTickets(absTicketsPath);
  if (errors.length) {
    return { ok: false, error: `ticket file errors:\n  ${errors.join('\n  ')}` };
  }

  if (tickets.length === 0) {
    return { ok: true, baseRef, write, ceremony, stale: [], active: [], tombstoned: [], ceremonyCompleted: [], needsCeremony: [] };
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
  const ticketsById = new Map(tickets.map((t) => [t.id, t]));

  if ((!write && !ceremony) || stale.length === 0) {
    // Dry-run (or nothing stale): report the needsCeremony drift so it is
    // visible BEFORE it blocks a PR — the #198 visibility fix. Nothing written.
    return {
      ok: true,
      baseRef,
      write,
      ceremony,
      stale,
      active,
      tombstoned: [],
      ceremonyCompleted: [],
      needsCeremony: computeNeedsCeremony(stale, ticketsById),
    };
  }

  let canonicalStore;
  try {
    canonicalStore = ticketsPath === '.adlc/tickets.json'
      ? detectTicketStore({ root: cwd })
      : detectTicketStore({ root: cwd, ticketStore: ticketsPath });
  }
  catch (error) { return { ok: false, error: error.message }; }
  if (canonicalStore instanceof DirectoryTicketStore) {
    // The directory store's write path archives stale tickets; the in-place
    // add-only completion the ceremony relies on is a legacy-flat-file operation
    // that has no equivalent here yet. Fail closed rather than mis-handle it.
    if (ceremony) {
      return { ok: false, error: 'ticket-prune --ceremony is not supported for the directory ticket store yet; complete rail-freezing tickets through the protected-base admin ceremony directly.' };
    }
    // Archive ONLY tombstone-eligible tickets — same boundary the legacy path
    // enforces. A rail-freezing or preexisting-completed-field ticket must NOT be
    // auto-archived: archiving removes it from the active store and so unfreezes
    // its rails without the per-ticket review the contract reserves for that. They
    // are reported under needsCeremony and completed per-ticket via
    // `adlc ticket complete`, exactly as on the legacy backend.
    const archivedEntries = [];
    const needsCeremony = [];
    const blocked = [];
    // Archive edge SOURCES before their TARGETS (T75). archiveTicket fails closed
    // on inbound edges, so a candidate referenced by another IN-BATCH candidate
    // must be archived only AFTER that referencing source is gone. Ordering by the
    // initial snapshot's edges is enough — each iteration still re-reads and
    // re-classifies against the CURRENT store below.
    const staleById = new Map(stale.map((r) => [r.id, r]));
    const orderedIds = orderArchiveCandidates(stale.map((r) => r.id), ticketsById);
    for (const id of orderedIds) {
      const item = staleById.get(id);
      try {
        // Re-read and re-classify against the CURRENT snapshot, then pass THAT
        // snapshot's hash to archiveTicket, so the disposition and the CAS come
        // from the same view. Taking the disposition from the initial load but
        // the hash from a later load would let a concurrent edit (rails added,
        // status changed, completed:false set) slip a reclassified ticket through
        // the CAS. This mirrors the legacy path's under-lock re-read.
        const current = canonicalStore.load();
        const ticket = current.get(id);
        if (!ticket) continue; // vanished under us since the first pass
        const reclassified = classifyTicket(ticket, trackedFiles);
        if (!reclassified.stale) continue; // un-staled since the first pass
        const disposition = ceremonyDisposition(ticket, reclassified.reason);
        if (disposition.disposition === 'done') continue;
        if (disposition.disposition === 'ceremony') {
          needsCeremony.push(disposition.entry); // rails-freeze / preexisting-completed-field → reported, not archived
          continue;
        }
        const result = archiveTicket(canonicalStore, resolve(cwd, '.adlc/ticket-archive'), id, {
          root: cwd,
          expectedSnapshotHash: current.hash,
          // The RE-classified reason, not the first pass's: archiveTicket embeds this
          // permanently in _adlcArchive, and the disposition + CAS already come from
          // `current`. Using the stale reason would immortalise a pre-edit rationale.
          reason: reclassified.reason,
          authorized: true,
        });
        archivedEntries.push(result.archived);
      } catch (error) {
        // ONLY the expected, per-ticket, recoverable block is swallowed-and-continued:
        // ARCHIVE_INBOUND_EDGE, where a ticket OUTSIDE this batch still references
        // `id`. That is the wedge T75 exists to fix — collect it (like needsCeremony)
        // and keep archiving the rest. EVERYTHING else — a corrupt/unreadable store,
        // a lock or CAS failure, an I/O or disk error, a transaction fault — is NOT
        // recoverable and must fail the sweep, or automation reading exit 0 would take
        // a broken store for a clean one. Preserve what was archived + the blocked set.
        if (error?.code === 'ARCHIVE_INBOUND_EDGE') {
          blocked.push({ id, reason: item?.reason ?? null, code: 'ARCHIVE_INBOUND_EDGE', error: error.message });
          continue;
        }
        return {
          ok: false,
          baseRef, write, ceremony, stale, active,
          archived: archivedEntries, needsCeremony, blocked,
          failedId: id,
          code: error?.code ?? 'ARCHIVE_FAILED',
          error: `archiving ${id} failed: ${error.message}`,
        };
      }
    }
    return { ok: true, baseRef, write, ceremony, stale, active, archived: archivedEntries, needsCeremony, blocked };
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
      return { ok: false, error: `ticket file disappeared during prune: ${absTicketsPath}` };
    }
    const freshTickets = Array.isArray(rawUnderLock.tickets) ? rawUnderLock.tickets : [];

    const staleIds = new Set(stale.map((r) => r.id));
    const staleCandidates = freshTickets.filter((t) => staleIds.has(t.id));

    // Re-classify each candidate against the fresh content read under the
    // lock rather than trusting the pre-lock `stale`/reason data: another
    // writer (e.g. ticket-sync, or a human editor) may have mutated a
    // ticket's content between the initial classification and now in a way
    // that un-stales it (e.g. flipped `status` from "done" back to
    // "in-progress", or edited `scope`). Tombstoning on the stale
    // classification anyway would silently complete a currently-active ticket.
    // #104: TOMBSTONE rails-less stale tickets with `completed: true` IN PLACE
    // (never physical removal — the rails-guard CI gate hard-denies that; the
    // in-place add-only annotation it accepts for a rails-less ticket, so the
    // prune output merges through an ordinary PR).
    // The only in-place write this tool performs is TOMBSTONING rails-less stale
    // tickets under --write (add-only `completed: true`). Completing rail-freezing
    // tickets is NOT done here anymore — that was `--ceremony`, deprecated above
    // (#208); rail-freezing entries are always just reported under needsCeremony,
    // to be completed per-ticket via `adlc ticket complete`. `ceremonyCompleted`
    // is retained in the result shape (always empty) for consumer compatibility.
    const tombstoneIds = new Set();
    const tombstoned = [];
    const ceremonyCompleted = [];
    const needsCeremony = [];
    for (const ticket of staleCandidates) {
      const reclassified = classifyTicket(ticket, trackedFiles);
      if (!reclassified.stale) continue;                 // un-staled under the lock — leave it
      const disposition = ceremonyDisposition(ticket, reclassified.reason);
      if (disposition.disposition === 'done') continue;  // already completed — nothing to do
      if (disposition.disposition === 'tombstone') {
        if (write) {
          tombstoneIds.add(ticket.id);
          tombstoned.push({ id: ticket.id, reason: reclassified.reason });
        }
        continue;
      }
      // disposition === 'ceremony' — reported, never completed in-place here.
      needsCeremony.push(disposition.entry);
    }

    const writeIds = tombstoneIds;
    if (writeIds.size === 0) {
      // Nothing writable this pass (all stale ids were un-staled, already
      // completed, or are rail-freezing/preexisting-completed-field entries this
      // tool only reports). tickets.json is left untouched.
      return { ok: true, baseRef, write, ceremony, stale, active, tombstoned, ceremonyCompleted, needsCeremony };
    }

    // Add ONLY `completed: true` to each tombstoned ticket — the exact single-field
    // annotation the gate accepts for a rails-less tombstone; touching any other
    // field would make an ordinary-PR tombstone diff un-mergeable.
    const updatedTickets = freshTickets.map((t) =>
      writeIds.has(t.id) ? { ...t, completed: true } : t);

    try {
      writeJsonAtomic(absTicketsPath, { ...rawUnderLock, tickets: updatedTickets });
    } catch (err) {
      return { ok: false, error: `failed to write completions to tickets.json: ${err.message}` };
    }

    return { ok: true, baseRef, write, ceremony, stale, active, tombstoned, ceremonyCompleted, needsCeremony };
  } finally {
    releaseLock(cwd);
  }
}
