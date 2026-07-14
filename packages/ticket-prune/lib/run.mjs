// run.mjs — the whole ticket-prune operation as one pure-ish, testable
// function. bin/ticket-prune.mjs stays a thin arg-parse + exit-code shell
// around this (CONVENTIONS layout rule).

import { resolve } from 'node:path';
import { loadTickets } from '@adlc/core';
import { classifyTicket, classifyTickets, listTrackedFiles } from './detect.mjs';
import { acquireLock, releaseLock, readJson, writeJsonAtomic } from './store.mjs';
import { DirectoryTicketStore, archiveTicket, detectTicketStore } from '@adlc/tickets';

/**
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.ticketsPath] relative to cwd
 * @param {string} [options.baseRef] git ref to check scope/rails existence against
 * @param {boolean} [options.write] tombstone stale tickets in place instead of dry-run reporting
 * @returns {{ok: true, baseRef: string, write: boolean, stale: object[], active: object[], tombstoned: {id: string, reason: string}[], needsCeremony: {id: string, reason: string, rails: string[], blocker: 'rails-freeze' | 'preexisting-completed-field'}[]} | {ok: false, error: string}}
 */
export function runTicketPrune(options = {}) {
  const {
    cwd = process.cwd(),
    ticketsPath = '.adlc/tickets.json',
    baseRef = 'HEAD',
    write = false,
  } = options;

  // path.resolve (unlike path.join) treats an absolute ticketsPath as an
  // override of cwd rather than concatenating onto it, so `--tickets
  // /abs/path.json` behaves the way users naturally expect.
  const absTicketsPath = resolve(cwd, ticketsPath);

  const { tickets, errors } = loadTickets(absTicketsPath);
  if (errors.length) {
    return { ok: false, error: `ticket file errors:\n  ${errors.join('\n  ')}` };
  }

  if (tickets.length === 0) {
    return { ok: true, baseRef, write, stale: [], active: [], tombstoned: [], needsCeremony: [] };
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
    return { ok: true, baseRef, write, stale, active, tombstoned: [], needsCeremony: [] };
  }

  let canonicalStore;
  try {
    canonicalStore = ticketsPath === '.adlc/tickets.json'
      ? detectTicketStore({ root: cwd })
      : detectTicketStore({ root: cwd, ticketStore: ticketsPath });
  }
  catch (error) { return { ok: false, error: error.message }; }
  if (canonicalStore instanceof DirectoryTicketStore) {
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
      return { ok: true, baseRef, write, stale, active, archived: archivedEntries };
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
    // #104: TOMBSTONE stale tickets with `completed: true` IN PLACE instead of
    // physically removing them. Removal produced a diff the rails-guard CI gate
    // hard-denies ("base ticket cannot be removed"); an in-place `completed: true`
    // annotation is accepted by that gate for a RAILS-LESS ticket (it grants no
    // unfreeze privilege — see rails-guard-ci.mjs isCompletionAnnotationOnly), so
    // the prune output now merges through an ordinary PR. A stale ticket that
    // STILL freezes rails is NOT auto-tombstoned here: completing it also expires
    // its rails (privileged), which the gate reserves for the protected-base
    // admin ceremony — those are reported under `needsCeremony`. Re-classify
    // under the lock so a concurrently un-staled ticket is never tombstoned.
    const tombstoneIds = new Set();
    const tombstoned = [];
    const needsCeremony = [];
    for (const ticket of staleCandidates) {
      const reclassified = classifyTicket(ticket, trackedFiles);
      if (!reclassified.stale) continue;                 // un-staled under the lock — leave it
      if (ticket.completed === true) continue;           // already tombstoned — nothing to do

      // The gate's isCompletionAnnotationOnly exemption is BOTH rails-less AND
      // strictly add-only: it rejects a base ticket that freezes rails, and it
      // rejects one that already carries a `completed` field (only a pristine
      // ticket may GAIN `completed: true`). Mirror BOTH predicates exactly, so
      // the writer can only ever emit a diff the gate accepts — otherwise prune
      // produces an unmergeable PR (a rails-less ticket already holding
      // `completed: false`/`null` would be rewritten to `true`, a MUTATION the
      // gate denies). Anything ineligible is reported for the admin ceremony
      // (ADLC_RAILS_BYPASS), never silently rewritten.
      const rails = Array.isArray(ticket.rails) ? ticket.rails : [];
      if (rails.length > 0) {
        // Frozen rails → completing it would unfreeze them; admin-ceremony only.
        needsCeremony.push({ id: ticket.id, reason: reclassified.reason, rails, blocker: 'rails-freeze' });
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(ticket, 'completed')) {
        // `completed` present but not true (false/null/other): completing it
        // MUTATES an existing field, which the add-only gate exemption denies.
        needsCeremony.push({
          id: ticket.id,
          reason: reclassified.reason,
          rails,
          blocker: 'preexisting-completed-field',
        });
        continue;
      }
      tombstoneIds.add(ticket.id);
      tombstoned.push({ id: ticket.id, reason: reclassified.reason });
    }

    if (tombstoneIds.size === 0) {
      // Nothing PR-mergeable to tombstone (all stale ids were un-staled, already
      // tombstoned, or need the ceremony). tickets.json is left untouched.
      return { ok: true, baseRef, write, stale, active, tombstoned: [], needsCeremony };
    }

    // Add ONLY `completed: true` to each tombstoned ticket — the exact single-
    // field annotation the gate accepts; touching any other field would make the
    // diff un-mergeable again.
    const updatedTickets = freshTickets.map((t) =>
      tombstoneIds.has(t.id) ? { ...t, completed: true } : t);

    try {
      writeJsonAtomic(absTicketsPath, { ...rawUnderLock, tickets: updatedTickets });
    } catch (err) {
      return { ok: false, error: `failed to write tombstones to tickets.json: ${err.message}` };
    }

    return { ok: true, baseRef, write, stale, active, tombstoned, needsCeremony };
  } finally {
    releaseLock(cwd);
  }
}
