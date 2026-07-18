// detect.mjs — decide whether a ticket is stale (shipped, safe to tombstone).
//
// Source-of-truth decision (documented per issue #39's open question):
//
//   1. PREFER an explicit `status` field when the ticket carries one. The
//      current @adlc/core ticket schema (packages/core/lib/tickets.mjs) does
//      NOT declare a `status` field — validateTicket() only checks id, title,
//      scope, rails, edges, duration — but it also does not reject unknown
//      extra properties, so a ticket may already carry `status: "done"` (or
//      any other string) without failing validation. When present, this is
//      the most reliable signal: it is an explicit, author-asserted fact, not
//      an inference, so it wins over everything else (including a
//      contradicting scope/rails inference).
//
//   2. OTHERWISE infer from whether the ticket's declared `scope` files exist
//      on a base ref (default HEAD; see listTrackedFiles). A ticket whose
//      every declared scope glob resolves to at least one file tracked at
//      that ref is treated as shipped.
//
// Why scope-existence over "closing PR reference" (the other option the
// issue floats): this repo's ticket schema has no field that records a PR
// number, and commit-message conventions are NOT reliable enough to infer one
// — a survey of `git log --oneline` on this repo shows tickets referenced
// inconsistently (e.g. "(T13/T14)" is called out explicitly in a subject line,
// but the OpenCode T1-T5 tickets' shipping commits/PRs (#27-#31) reference
// "Phase A/B/C/E" and never the literal ticket ids at all). Grepping commit
// history for a ticket id would therefore miss exactly the stale tickets the
// issue's own worked example was written to catch. Scope-existence against a
// tracked-files snapshot is deterministic, needs no heuristic text matching,
// and is exactly the signal the issue's worked example (T1-T5) used by hand.
// A ticket that declares no scope can never be inferred stale this way — it
// is reported as active until an explicit status settles the question.

import { git, globMatch } from '@adlc/core';

const DONE_STATUSES = new Set(['done', 'closed', 'complete', 'completed', 'archived', 'shipped']);

/** Lowercased status string, or null if the ticket has no string status field. */
export function explicitStatus(ticket) {
  return typeof ticket?.status === 'string' ? ticket.status.toLowerCase() : null;
}

/** True only when the ticket carries an explicit done-shaped status. */
export function isExplicitlyDone(ticket) {
  const status = explicitStatus(ticket);
  return status !== null && DONE_STATUSES.has(status);
}

/** Files tracked at `ref` (default HEAD) — the "base ref" existence check. */
export function listTrackedFiles(ref = 'HEAD', cwd = process.cwd()) {
  let out;
  try {
    out = git(['ls-tree', '-r', '--name-only', ref], { cwd });
  } catch (err) {
    throw new Error(`could not list files at ref "${ref}": ${err.message}`);
  }
  return out.split('\n').filter(Boolean);
}

/**
 * True only when the ticket declares at least one scope glob AND every glob
 * matches at least one tracked file. A ticket with no declared scope is never
 * inferred shipped (there is nothing to check existence of).
 */
export function scopeShipped(ticket, trackedFiles) {
  const scope = ticket?.scope ?? [];
  if (scope.length === 0) return false;
  return scope.every((glob) => trackedFiles.some((file) => globMatch(glob, file)));
}

/** Classify one ticket. Returns { id, stale, reason }. */
export function classifyTicket(ticket, trackedFiles) {
  const status = explicitStatus(ticket);
  if (status !== null) {
    return {
      id: ticket.id,
      stale: isExplicitlyDone(ticket),
      reason: `explicit status: "${ticket.status}"`,
    };
  }

  const scope = ticket?.scope ?? [];
  if (scope.length === 0) {
    return {
      id: ticket.id,
      stale: false,
      reason: 'no explicit status and no declared scope — cannot infer, treated as active',
    };
  }

  if (scopeShipped(ticket, trackedFiles)) {
    return {
      id: ticket.id,
      stale: true,
      reason: `inferred: all ${scope.length} declared scope glob(s) resolve to tracked files on the base ref`,
    };
  }

  return {
    id: ticket.id,
    stale: false,
    reason: 'no explicit status; declared scope not fully present on the base ref',
  };
}

export function classifyTickets(tickets, trackedFiles) {
  return tickets.map((ticket) => classifyTicket(ticket, trackedFiles));
}

/**
 * Given a ticket already classified STALE (shipped), decide HOW it can be
 * completed. This is the single source of truth shared by ticket-prune's
 * dry-run report and its write/ceremony paths, so what the dry-run surfaces is
 * exactly what a write would do (#198).
 *
 * Returns one of:
 *   { disposition: 'done' }                       already completed:true — nothing to do
 *   { disposition: 'tombstone' }                  rails-less + pristine — an ordinary PR
 *                                                 may add completed:true (rails-guard's
 *                                                 isCompletionAnnotationOnly exemption)
 *   { disposition: 'ceremony', entry: {...} }     requires the protected-base admin
 *                                                 ceremony; entry carries { id, reason,
 *                                                 rails, blocker }
 *
 * Blocker kinds (mirror rails-guard-ci.mjs's two denial reasons exactly):
 *   'rails-freeze'                completing it would expire frozen rails (privileged)
 *   'preexisting-completed-field' it already carries a `completed` field, so setting
 *                                 it is a MUTATION the add-only PR exemption denies
 * The rails check comes FIRST, matching the write path's original ordering.
 */
export function ceremonyDisposition(ticket, reason) {
  if (ticket.completed === true) return { disposition: 'done' };
  const rails = Array.isArray(ticket.rails) ? ticket.rails : [];
  if (rails.length > 0) {
    return { disposition: 'ceremony', entry: { id: ticket.id, reason, rails, blocker: 'rails-freeze' } };
  }
  if (Object.prototype.hasOwnProperty.call(ticket, 'completed')) {
    return { disposition: 'ceremony', entry: { id: ticket.id, reason, rails, blocker: 'preexisting-completed-field' } };
  }
  return { disposition: 'tombstone' };
}
