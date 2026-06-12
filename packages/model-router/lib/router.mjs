/**
 * Top-level model-router logic. Orchestrates loading, CPM, priors, assignment,
 * and gate checking.
 *
 * Returns { assignments, p3Findings, error? }
 */

import { loadTickets, computeFloat } from '../../core/index.mjs';
import { readEntries, ADLC_DIR } from '../../core/index.mjs';
import { buildPriors } from './priors.mjs';
import { assignAll } from './assign.mjs';
import { FRONTIER_CATEGORIES } from './assign.mjs';

/**
 * Run the model routing pipeline.
 *
 * @param {object} opts
 * @param {string} [opts.ticketsPath] - path to tickets.json
 * @param {number} [opts.floor=0.2] - rail density floor
 * @param {string} [opts.adlcDir] - override .adlc dir (for tests)
 * @returns {{ assignments, p3Findings, ticketErrors, skippedLedger }}
 *   or throws with a message suitable for opError()
 */
export async function runRouter(opts = {}) {
  const {
    ticketsPath,
    floor = 0.2,
    adlcDir = ADLC_DIR,
  } = opts;

  // Load tickets
  const { tickets, errors: ticketErrors } = loadTickets(ticketsPath);
  if (ticketErrors.length > 0) {
    throw Object.assign(new Error(ticketErrors.join('\n')), { isOpError: true });
  }

  if (tickets.length === 0) {
    return { assignments: [], p3Findings: [], ticketErrors, skippedLedger: [] };
  }

  // Compute CPM float
  const cpmResult = computeFloat(tickets);
  if (cpmResult.error) {
    throw Object.assign(new Error(cpmResult.error), { isOpError: true });
  }

  // Load manifest ledger for priors
  const { entries, skipped: skippedLedger } = readEntries('manifest', adlcDir);
  const priors = buildPriors(entries);

  // Assign routes
  const assignments = assignAll(tickets, cpmResult, priors, floor);

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
