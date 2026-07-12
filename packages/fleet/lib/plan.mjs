// Plan derivation for the fleet scheduler (spec §3, §9).
//
// The plan source is `.adlc/tickets.json` itself — NOT a new format. This module
// is pure: given the ticket array and the current run state it computes which
// tickets are *ready* to dispatch. All ordering/serialization decisions live
// here so the scheduler (state + I/O) and this (policy) stay separable and the
// policy is unit-testable offline.

import { loadTickets, scopesOverlap } from '@adlc/core';

/**
 * Active set = every ticket the fleet may still act on. A ticket marked
 * `completed: true` is excluded (repo invariant #104 — the fleet is a new
 * backlog consumer and MUST filter it) but still satisfies edges (§3).
 */
export function activeTickets(all) {
  return all.filter((t) => t.completed !== true);
}

/**
 * Ids of the direct prerequisites of `id`. Edge direction is
 * prerequisite → dependent, so a prerequisite T0 carries `{ to: id }`; the
 * prerequisites of `id` are therefore every ticket that has an edge to `id`.
 */
export function predecessorsOf(id, all) {
  return all
    .filter((t) => (t.edges ?? []).some((e) => e && e.to === id))
    .map((t) => t.id);
}

/**
 * The set of ids that count as "done" for edge satisfaction: any ticket the run
 * has merged this session, PLUS any `completed: true` ticket (a pre-merged
 * prerequisite). `statusById` maps ticket id → run state string.
 */
export function mergedOrCompleted(all, statusById = {}) {
  const done = new Set(
    all.filter((t) => t.completed === true).map((t) => t.id)
  );
  for (const [id, s] of Object.entries(statusById)) {
    if (s === 'merged') done.add(id);
  }
  return done;
}

/**
 * Tickets whose edge-predecessors are all satisfied, that are not already
 * in a terminal/in-flight state, and whose scope does not overlap any
 * currently in-flight ticket (scope-overlapping tickets are serialized, never
 * concurrent — merge conflicts are scheduled, not resolved: §3).
 *
 * @param all         full ticket array (from tickets.json)
 * @param statusById  map id → run state ('pending'|'building'|…|'merged'|'failed'|'blocked')
 * @param inFlightIds ids currently occupying a worker slot (building/gating/prosecuting/merging/fixing)
 * @param onlyIds     optional subset restriction (the --tickets flag). Undefined = all.
 */
export function computeReady(all, { statusById = {}, inFlightIds = [], onlyIds } = {}) {
  const active = activeTickets(all);
  const done = mergedOrCompleted(all, statusById);
  const byId = new Map(all.map((t) => [t.id, t]));
  const inFlight = inFlightIds.map((id) => byId.get(id)).filter(Boolean);
  const subset = onlyIds ? new Set(onlyIds) : null;

  const ready = [];
  for (const t of active) {
    if (subset && !subset.has(t.id)) continue;
    const s = statusById[t.id];
    // Only pristine/pending tickets are dispatch candidates; anything already
    // building, merged, failed, or blocked is not re-dispatched.
    if (s && s !== 'pending') continue;
    const preds = predecessorsOf(t.id, all);
    if (!preds.every((p) => done.has(p))) continue;
    if (inFlight.some((f) => scopesOverlap(f, t))) continue;
    ready.push(t);
  }
  return ready;
}

/**
 * A ticket in `onlyIds` whose predecessor is neither in the subset, merged, nor
 * completed is reported BLOCKED rather than silently skipped (§3). Returns the
 * ids that can never become ready under the current subset.
 */
export function unsatisfiableInSubset(all, { onlyIds, statusById = {} }) {
  if (!onlyIds) return [];
  const subset = new Set(onlyIds);
  const done = mergedOrCompleted(all, statusById);
  const blocked = [];
  for (const id of onlyIds) {
    const preds = predecessorsOf(id, all);
    const stuck = preds.some((p) => !subset.has(p) && !done.has(p));
    if (stuck) blocked.push(id);
  }
  return blocked;
}

/**
 * Greedily admit ready tickets up to a free-slot budget such that no two
 * admitted tickets have overlapping scope with each other or with the already
 * in-flight set (single writer per partition). Deterministic: preserves the
 * input order of `ready` (tickets.json order), so a run is reproducible.
 */
export function selectDispatchable(ready, inFlightTickets, freeSlots) {
  const admitted = [];
  const held = [...inFlightTickets];
  for (const t of ready) {
    if (admitted.length >= freeSlots) break;
    if (held.some((h) => scopesOverlap(h, t))) continue;
    admitted.push(t);
    held.push(t);
  }
  return admitted;
}

/** Convenience: load + validate tickets from disk via core. */
export function loadPlan(ticketsPath) {
  return loadTickets(ticketsPath);
}
