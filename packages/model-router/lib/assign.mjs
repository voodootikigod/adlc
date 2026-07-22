/**
 * Model assignment logic.
 *
 * ASSIGNMENT RULES:
 *
 * 1. FRONTIER / DIRECT
 *    - ticket.category is one of ['contract', 'spec', 'architecture']
 *    - OR railDensity < floor
 *    → tier: 'frontier', mode: 'direct'
 *    → reason includes which condition triggered
 *
 * 2. DIRECT (mid or best-prior tier, critical path)
 *    - float === 0 (ticket is on the critical path)
 *    → mode: 'direct'
 *    → tier: best tier from prior data with >= 3 samples, else 'mid'
 *
 * 3. LADDER (has slack → cost-optimal)
 *    - float > 0
 *    → mode: 'ladder'
 *    → startTier: railDensity >= 0.5 ? 'cheap' : 'mid'
 */

import { railDensity as computeRailDensity } from './density.mjs';
import { bestTierFromPriors } from './priors.mjs';

const FRONTIER_CATEGORIES = new Set(['contract', 'spec', 'architecture']);

/**
 * Default per-tier token ceilings (ADLC.md D1: model-router emits
 * `{model, mode, budget}`; ADLC.md Principle 8: every loop carries "a token
 * budget"). These are a conservative starting point, NOT measured priors —
 * there is no gate-manifest token-spend history to derive them from yet
 * (see issue #272). Once gate-manifest records real per-phase spend, these
 * should be replaced by empirical per-category/per-tier priors the same way
 * `bestTierFromPriors` already replaces a static tier table for model choice.
 */
const DEFAULT_TIER_BUDGET = {
  cheap: 50_000,
  mid: 150_000,
  frontier: 400_000,
};

/**
 * Resolve the token budget to emit for a ticket assignment.
 *
 * - An explicit `ticket.budget` (the existing ticket-schema field) always
 *   wins — the ticket author knows their own scope best.
 * - `direct` mode gets the assigned tier's default ceiling.
 * - `ladder` mode may regenerate up through a higher tier on gate failure
 *   (escalation is a fresh attempt, never a rescue — F8), so its budget
 *   covers the worst case: the starting tier plus one frontier-tier
 *   regeneration, not just the starting tier alone.
 */
function resolveBudget(ticket, tier, mode) {
  if (typeof ticket.budget === 'number' && ticket.budget > 0) return ticket.budget;
  if (mode === 'ladder') return DEFAULT_TIER_BUDGET[tier] + DEFAULT_TIER_BUDGET.frontier;
  return DEFAULT_TIER_BUDGET[tier];
}

/**
 * Assign routing for one ticket.
 *
 * @param {object} ticket
 * @param {number} float - CPM float for this ticket
 * @param {object} priors - { global, byCategory } from buildPriors()
 * @param {number} floor - rail density floor (default 0.2)
 * @returns {{ id, tier, mode, railDensity, float, budget, reason }}
 */
export function assignTicket(ticket, float, priors, floor = 0.2) {
  const density = computeRailDensity(ticket);
  const id = ticket.id;

  // Rule 1: Frontier categories
  if (FRONTIER_CATEGORIES.has(ticket.category)) {
    return {
      id,
      tier: 'frontier',
      mode: 'direct',
      railDensity: density,
      float,
      budget: resolveBudget(ticket, 'frontier', 'direct'),
      reason: `category '${ticket.category}' requires frontier model`,
    };
  }

  // Rule 1b: Below rail density floor
  if (density < floor) {
    return {
      id,
      tier: 'frontier',
      mode: 'direct',
      railDensity: density,
      float,
      budget: resolveBudget(ticket, 'frontier', 'direct'),
      reason: `railDensity ${density.toFixed(3)} < floor ${floor} → frontier (P3 finding)`,
    };
  }

  // Rule 2: Critical path (float === 0)
  if (float === 0) {
    const tier = bestTierFromPriors(priors, ticket.category);
    return {
      id,
      tier,
      mode: 'direct',
      railDensity: density,
      float,
      budget: resolveBudget(ticket, tier, 'direct'),
      reason: `critical path (float=0) → direct with best-prior tier '${tier}'`,
    };
  }

  // Rule 3: Has float → ladder (cost-optimal)
  const startTier = density >= 0.5 ? 'cheap' : 'mid';
  return {
    id,
    tier: startTier,
    mode: 'ladder',
    railDensity: density,
    float,
    budget: resolveBudget(ticket, startTier, 'ladder'),
    reason: `float=${float} → ladder starting at '${startTier}' (railDensity=${density.toFixed(3)})`,
  };
}

/**
 * Assign routing for all tickets.
 *
 * @param {Array} tickets
 * @param {{ floats: object }} cpmResult
 * @param {object} priors
 * @param {number} floor
 * @returns {Array<{ id, tier, mode, railDensity, float, budget, reason }>}
 */
export function assignAll(tickets, cpmResult, priors, floor = 0.2) {
  return tickets.map((ticket) => {
    const float = cpmResult.floats[ticket.id] ?? 0;
    return assignTicket(ticket, float, priors, floor);
  });
}

export { FRONTIER_CATEGORIES };
