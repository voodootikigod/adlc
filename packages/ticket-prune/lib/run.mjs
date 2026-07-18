// run.mjs — the whole ticket-prune operation as one pure-ish, testable
// function. bin/ticket-prune.mjs stays a thin arg-parse + exit-code shell
// around this (CONVENTIONS layout rule).

import { resolve } from 'node:path';
import { loadTickets } from '@adlc/core';
import { classifyTicket, classifyTickets, ceremonyDisposition, listTrackedFiles } from './detect.mjs';
import { acquireLock, releaseLock, readJson, writeJsonAtomic } from './store.mjs';
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

  // The ceremony COMPLETES rail-freezing shipped tickets, which expires their
  // rails (T36) — a privilege an ordinary PR's rails-guard gate denies
  // (assertBaseTicketContractsPreserved). Its output only lands via the
  // protected-base/admin path, so gate it behind the same recorded override the
  // gate itself uses (ADLC_RAILS_BYPASS=1) and write nothing without it. Checked
  // FIRST, before any read, so a misfire never mutates the store.
  if (ceremony && process.env.ADLC_RAILS_BYPASS !== '1') {
    return {
      ok: false,
      error:
        'ticket-prune --ceremony completes rail-freezing tickets (expiring their rails), a protected-base admin action; set ADLC_RAILS_BYPASS=1 to run it. Refusing and writing nothing.',
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
    const archivedEntries = [];
    try {
      for (const item of stale) {
        const current = canonicalStore.load();
        const result = archiveTicket(canonicalStore, resolve(cwd, '.adlc/ticket-archive'), item.id, {
          root: cwd,
          expectedSnapshotHash: current.hash,
          reason: item.reason,
          authorized: true,
        });
        archivedEntries.push(result.archived);
      }
      return { ok: true, baseRef, write, ceremony, stale, active, archived: archivedEntries };
    } catch (error) {
      return { ok: false, error: error.message };
    }
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
    // #198: under --ceremony (admin-gated above), ALSO complete rail-freezing
    // stale tickets in place — the one action reserved for the protected-base
    // admin ceremony (completing them expires their rails, T36). Both share the
    // same add-only completed:true edit and the same re-classification guard.
    const tombstoneIds = new Set();
    const tombstoned = [];
    const completeIds = new Set();
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
      // disposition === 'ceremony'
      if (ceremony && disposition.entry.blocker === 'rails-freeze') {
        // The protected-base action this whole flow exists for: complete the
        // rail-freezing shipped ticket so its rails expire. Only the
        // 'rails-freeze' blocker is completed — a 'preexisting-completed-field'
        // ticket would need a field MUTATION (overwriting a deliberately-set
        // value), a distinct, riskier operation kept out of scope; it stays
        // reported under needsCeremony.
        completeIds.add(ticket.id);
        ceremonyCompleted.push({ id: ticket.id, reason: reclassified.reason, rails: disposition.entry.rails });
      } else {
        needsCeremony.push(disposition.entry);
      }
    }

    const writeIds = new Set([...tombstoneIds, ...completeIds]);
    if (writeIds.size === 0) {
      // Nothing writable this pass (all stale ids were un-staled, already
      // completed, tombstone-only under a ceremony-only run, or need a ceremony
      // this run isn't performing). tickets.json is left untouched.
      return { ok: true, baseRef, write, ceremony, stale, active, tombstoned, ceremonyCompleted, needsCeremony };
    }

    // Add ONLY `completed: true` to each written ticket — the exact single-field
    // annotation the gate accepts for a rails-less tombstone, and the minimal
    // diff PR #199 used for the admin ceremony; touching any other field would
    // make an ordinary-PR tombstone diff un-mergeable.
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
