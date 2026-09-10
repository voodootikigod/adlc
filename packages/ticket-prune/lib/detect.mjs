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
//   2. OTHERWISE, and ONLY when the caller opts in with `inferScope`, infer
//      from whether the ticket's declared `scope` files exist on a base ref
//      (default HEAD; see listTrackedFiles). A ticket whose every declared
//      scope glob resolves to at least one file tracked at that ref is
//      treated as shipped.
//
// Why the inference is OPT-IN (#779). Scope existence is not evidence that the
// ticket's work landed: it asks "does `packages/core/**` match a tracked file?",
// which on any repo older than its ticket backlog is true the moment the ticket
// is authored — the directory was already there. Nothing checks that the scope
// files CHANGED, that the ticket created them, or that the ticket ever entered
// a build. Left on by default it classified 179 of this repo's 206 tickets as
// stale, and `--write` then archived every rails-less one of them — open,
// never-started work — reporting `ok: true` and exit 0 with a success line. So
// the default answers only from an author-asserted `status`, and a caller that
// genuinely wants the weaker signal (see scripts/ceremony-drift.mjs) asks for
// it by name.
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

/**
 * The reason reported when a statusless ticket is left active because the
 * scope-existence inference was not enabled. Deliberately distinct from
 * "declared scope not fully present": that one says the check RAN and failed,
 * this one says it never ran. Collapsing them would hide which classifier
 * produced the counts an operator is reading.
 */
const INFERENCE_OFF_REASON =
  'no explicit status; scope-existence inference is off (pass --infer-scope to enable it)';

/**
 * Classify one ticket. Returns { id, stale, reason }.
 *
 * @param {object} ticket
 * @param {string[]} trackedFiles
 * @param {{inferScope?: boolean}} [options] `inferScope` (default FALSE) enables
 *   the scope-existence fallback described in the module header. With it off, a
 *   ticket with no explicit status is never inferred stale.
 */
export function classifyTicket(ticket, trackedFiles, { inferScope = false } = {}) {
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

  // Checked BEFORE scopeShipped, so with the inference off the answer never
  // depends on the tracked-file snapshot at all — an inference that is off
  // must not be able to change the reported reason.
  if (!inferScope) {
    return { id: ticket.id, stale: false, reason: INFERENCE_OFF_REASON };
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

/** Map classifyTicket over an array, threading the same options to each. */
export function classifyTickets(tickets, trackedFiles, { inferScope = false } = {}) {
  return tickets.map((ticket) => classifyTicket(ticket, trackedFiles, { inferScope }));
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
  // A `completed` field that is PRESENT but not `true` (e.g. deliberately
  // `false` to keep rails frozen during follow-up work) is a value someone set
  // on purpose. It must route to manual review — 'preexisting-completed-field' —
  // BEFORE the rails check, not after. Otherwise a railed `completed: false`
  // ticket is classified 'rails-freeze', and the reporter would advertise a
  // completion command that overwrites the deliberate value with `true` and
  // expires its rails. The blocker carries the rails so the report still shows
  // them; it is simply never presented as safe to bulk-complete.
  if (Object.prototype.hasOwnProperty.call(ticket, 'completed')) {
    return { disposition: 'ceremony', entry: { id: ticket.id, reason, rails, blocker: 'preexisting-completed-field' } };
  }
  if (rails.length > 0) {
    return { disposition: 'ceremony', entry: { id: ticket.id, reason, rails, blocker: 'rails-freeze' } };
  }
  return { disposition: 'tombstone' };
}
