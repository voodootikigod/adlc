// run.mjs — the whole ticket-prune operation as one pure-ish, testable
// function. bin/ticket-prune.mjs stays a thin arg-parse + exit-code shell
// around this (CONVENTIONS layout rule).

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { loadTickets } from '@adlc/core';
import { classifyTicket, classifyTickets, ceremonyDisposition, listTrackedFiles } from './detect.mjs';
import { acquireLock, releaseLock, readJson, stageJsonAtomic } from './store.mjs';
import { orderArchiveCandidates } from './archive-order.mjs';
import {
  DirectoryTicketStore, archiveTicket, assertSignableTrustRootWrite, detectTicketStore,
  recordTicketEvidence, storeHash,
} from '@adlc/tickets';

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
    key: pruneKey = null,
    allowUnsigned: pruneAllowUnsigned = false,
    // Seam, default null. The staged copy and the rename that commits it live in
    // the same directory, so no permission or file-type trick can let one succeed
    // and the other fail — and the rename is the ONE failure that leaves an audit
    // entry naming a store hash that was never reached. Injecting the stager is the
    // only way to exercise that path, and it hands a caller nothing they do not
    // already have: they passed the path this writes to. It defaults to NULL rather
    // than to `stageJsonAtomic` so the production path below stays a direct,
    // greppable call to the atomic writer — scripts/test/roundtrip-coverage's
    // writer-boundary guard finds tickets.json writers by scanning for exactly that
    // call, and a stager reached only through a parameter is the "fully-indirected
    // writer" its own docs admit it cannot see.
    stageJson = null,
  } = options;
  const {
    cwd = process.cwd(),
    ticketsPath = '.adlc/tickets.json',
    baseRef = 'HEAD',
    write = false,
    ceremony = false,
  } = options;

  // `--ceremony` is DEPRECATED (#208). It was a bulk completion: it took no
  // ticket ids and recomputed its target set at run time (a TOCTOU window and no
  // per-ticket filter), wrote tickets.json directly without
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
  const ticketsById = new Map(tickets.map((t) => [t.id, t]));
  const stale = results.filter((r) => r.stale);
  // Active = not stale AND not already completed (#311). classifyTicket answers
  // only "is this shipped?" from `status`/scope existence — it never consults
  // `completed`, so a completed ticket carrying no status (or a status that is
  // not done-shaped) comes back stale:false and would be reported as ACTIVE. The
  // ADLC completion-lifecycle invariant is that `completed: true` is THE
  // completion marker and every backlog consumer filters on it (rails union,
  // the backlog enumerators' activeTickets, this tool's own tombstone write);
  // this was the consumer that did not. Filtering here — the single point every
  // return site takes `active` from — corrects both backends and both the
  // dry-run and write paths at once. Completed tickets that ARE stale keep
  // flowing through `stale`/ceremonyDisposition untouched.
  const active = results.filter((r) => !r.stale && ticketsById.get(r.id)?.completed !== true);

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
          key: pruneKey,
          // Omitting this makes the documented --allow-unsigned opt-out work on the
          // legacy backend and silently not on this one — the flag is accepted at the
          // CLI, then dropped one call short of the writer that honours it.
          allowUnsigned: pruneAllowUnsigned,
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

    // This legacy path rewrites tickets.json DIRECTLY rather than through
    // TicketService, so the trust-root audit the service enforces does not reach it
    // of its own. It only ever tombstones rails-LESS tickets, but the file it
    // rewrites is the whole store — and if any ticket in that store declares a rail,
    // the store is a frozen trust root and this is a write to it, held to the same
    // contract. Not a trust root → both halves are no-ops and prune stays
    // zero-ceremony.
    const auditRequired = assertSignableTrustRootWrite(freshTickets, { key: pruneKey, allowUnsigned: pruneAllowUnsigned, root: cwd });

    // Add ONLY `completed: true` to each tombstoned ticket — the exact single-field
    // annotation the gate accepts for a rails-less tombstone; touching any other
    // field would make an ordinary-PR tombstone diff un-mergeable.
    const updatedTickets = freshTickets.map((t) =>
      writeIds.has(t.id) ? { ...t, completed: true } : t);

    // STAGE → AUDIT → COMMIT. This path has no journal, so the store write and the
    // manifest append cannot be one atomic act; the ordering decides which failure
    // is possible. Recording after a completed write can leave a real mutation with
    // NO record — the unauditable trust-root change this contract exists to prevent,
    // and undetectable afterwards, since the store just looks like it was always
    // that way. So the audit goes first, and the store write is split around it: by
    // the time the entry is appended, the content is already staged on disk and only
    // a same-directory rename remains. A failure before the audit leaves nothing
    // behind; a failure of the audit discards the staged copy and refuses with the
    // store untouched; a failure of the rename leaves an entry naming a hash the
    // store never reached — which is wrong, but nothing unaudited happened and the
    // ledger can say so: a compensating entry is appended below, and if even that
    // fails the refusal names the uncorrected claim.
    //
    // RESIDUAL, stated plainly because the compensation below can read as broader
    // than it is: it runs only when the rename THROWS. A crash or power loss between
    // the append and the rename leaves the false claim on disk with no in-process
    // correction, and this path has no journal and no startup reconciliation to find
    // it later. It stays DETECTABLE — the entry's storeHashAfter does not match the
    // store — but detection is on whoever audits the ledger, not on prune. Closing it
    // needs a durable journal or a recovery pass, which is more than this contract
    // builds. The ordering is still the right one: recording AFTER a completed write
    // risks a real mutation with NO record, which is undetectable rather than merely
    // wrong. Tracked for closure by ticket T-01M0WNX6P09HWKDK429XQ8GGRJ.
    let staged;
    try {
      const payload = { ...rawUnderLock, tickets: updatedTickets };
      staged = stageJson ? stageJson(absTicketsPath, payload) : stageJsonAtomic(absTicketsPath, payload);
    } catch (err) {
      return { ok: false, error: `failed to write completions to tickets.json: ${err.message}` };
    }

    if (auditRequired) {
      // A FRESH id per mutation, not one derived from the transition.
      //
      // A deterministic id (path + before/after hashes) buys retry convergence: a
      // re-run after a failed rename reuses its own entry instead of appending a
      // second. But it cannot tell a retry from a genuine REPEAT — revert a
      // tombstone in the store and re-apply it, and the second mutation computes the
      // same id and is silently accepted as an old retry, leaving a real change to a
      // trust root with no record. That is the exact failure this contract exists to
      // prevent, and it outranks the cosmetic cost it was buying: a duplicate entry
      // after a failed rename is noise, and both entries are true records of an
      // attempted transition, bound to the hashes that let a verifier tell which one
      // landed.
      const storeHashBefore = storeHash(freshTickets);
      const storeHashAfter = storeHash(updatedTickets);
      try {
        recordTicketEvidence(cwd, {
          key: pruneKey,
          transactionId: randomUUID(),
          operation: 'prune',
          gate: 'ticket-mutation',
          bypass: true,
          // The tombstoned ids, so an auditor reading the append-only evidence
          // alone can say WHICH tickets this entry authorized — store hashes prove
          // that something changed, not what.
          ticketIds: [...writeIds].sort(),
          storeHashBefore,
          storeHash: storeHashAfter,
        });
      } catch (err) {
        staged.discard();
        return { ok: false, error: `refusing to tombstone: the audit entry for this frozen-trust-root write could not be recorded (${err.message}); tickets.json is unchanged` };
      }
    }

    try {
      staged.commit();
    } catch (err) {
      staged.discard();
      // The audit was appended before this rename, so the manifest now names a
      // transition that did not land. It is append-only and cannot be retracted —
      // but it CAN be corrected. A compensating record says the store stayed at the
      // before-hash, so a reader of the ledger alone is told the truth rather than
      // left with a claim the store contradicts. Best effort: if this second append
      // also fails, both facts go into the error instead.
      let compensationError = null;
      if (auditRequired) {
        try {
          recordTicketEvidence(cwd, {
            key: pruneKey,
            transactionId: randomUUID(),
            operation: 'prune',
            action: 'abandoned',
            gate: 'ticket-mutation',
            bypass: true,
            ticketIds: [...writeIds].sort(),
            storeHashBefore: storeHash(freshTickets),
            storeHash: storeHash(freshTickets),
          });
        } catch (compErr) { compensationError = compErr.message; }
      }
      return {
        ok: false,
        error: `failed to write completions to tickets.json: ${err.message}`
          + (auditRequired
            ? compensationError
              ? `; the audit entry for the attempted mutation stands UNCORRECTED because the compensating record also failed (${compensationError}) — the manifest names a store hash that was never reached`
              : '; a compensating manifest entry records that the mutation did not land'
            : ''),
      };
    }

    return { ok: true, baseRef, write, ceremony, stale, active, tombstoned, ceremonyCompleted, needsCeremony };
  } finally {
    releaseLock(cwd);
  }
}
