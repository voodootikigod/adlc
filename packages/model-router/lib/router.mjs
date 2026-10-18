/**
 * Top-level model-router logic. Orchestrates loading, CPM, priors, assignment,
 * and gate checking.
 *
 * Returns { assignments, p3Findings, error? }
 */

import { loadTickets, computeFloat, ADLC_DIR, activeTickets } from '@adlc/core';
import { readManifestForest } from '@adlc/gate-manifest/lib/forest.mjs';
import { buildPriors } from './priors.mjs';
import { assignAll } from './assign.mjs';
import { FRONTIER_CATEGORIES } from './assign.mjs';
import { assertFloor, DEFAULT_FLOOR } from './floor.mjs';

/**
 * Run the model routing pipeline.
 *
 * @param {object} opts
 * @param {string} [opts.ticketsPath] - path to tickets.json
 * @param {number} [opts.floor=0.2] - rail density floor, in (0, 1] — 0 is rejected (#697)
 * @param {string} [opts.adlcDir] - override .adlc dir (for tests)
 * @param {string} [opts.ticketId] - optional ticket id to scope routing and gate findings
 * @returns {{ assignments, p3Findings, ticketErrors, skippedLedger }}
 *   or throws with a message suitable for opError()
 */
export async function runRouter(opts = {}) {
  const {
    ticketsPath,
    floor = DEFAULT_FLOOR,
    adlcDir = ADLC_DIR,
    ticketId,
  } = opts;

  // Before anything is read: an empty store returns early below, and a
  // disabling floor must never ride that early return to exit 0 (#697).
  assertFloor(floor);

  // Load tickets, then drop completed (tombstoned) tickets: a finished ticket
  // must not be assigned a model or gated as open backlog.
  const { tickets: allTickets, errors: ticketErrors } = loadTickets(ticketsPath);
  if (ticketErrors.length > 0) {
    throw Object.assign(new Error(ticketErrors.join('\n')), { isOpError: true });
  }
  const tickets = activeTickets(allTickets);

  // Load manifest ledger for priors — forest-aware (T-MANIFEST-FOREST): once
  // segmented, priors recorded post-cutover live in manifest.d/, not root.
  const { entries, skipped: skippedLedger } = readManifestForest(adlcDir);

  if (ticketId !== undefined && !tickets.some((t) => t.id === ticketId)) {
    throw Object.assign(new Error(`Ticket not found: ${ticketId}`), { isOpError: true });
  }

  if (tickets.length === 0) {
    return { assignments: [], p3Findings: [], ticketErrors, skippedLedger };
  }

  // Compute CPM float
  const cpmResult = computeFloat(tickets);
  if (cpmResult.error) {
    throw Object.assign(new Error(cpmResult.error), { isOpError: true });
  }

  const priors = buildPriors(entries);

  // Assign routes
  const allAssignments = assignAll(tickets, cpmResult, priors, floor);
  const assignments = ticketId !== undefined
    ? allAssignments.filter((a) => a.id === ticketId)
    : allAssignments;

  // P3 gate: any non-frontier-category ticket with railDensity < floor
  const p3Findings = assignments
    .filter((a) => {
      const ticket = tickets.find((t) => t.id === a.id);
      return !FRONTIER_CATEGORIES.has(ticket?.category) && a.railDensity < floor;
    })
    .map((a) => ({
      id: a.id,
      railDensity: a.railDensity,
      floor,
      message: `P3 finding: ticket ${a.id} not railed enough to build cheaply (railDensity=${a.railDensity.toFixed(3)} < floor=${floor})`,
    }));

  return { assignments, p3Findings, ticketErrors, skippedLedger };
}
