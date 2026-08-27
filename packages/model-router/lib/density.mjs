/**
 * Rail density computation.
 *
 * railDensity = rails.length / scope.length  clamped to [0, 1]
 * If the ticket has no rails array (or it is empty), density = 0.
 * If the ticket has rails but no scope array (or it is empty), density = 0 —
 * NOT 1: the old max(1, scope.length) denominator made an unbounded ticket
 * look perfectly railed and routed it to the cheapest tier (#698).
 */

/** Compute the rail density for a single ticket. */
export function railDensity(ticket) {
  if (!Array.isArray(ticket.rails) || ticket.rails.length === 0) return 0;
  if (!Array.isArray(ticket.scope) || ticket.scope.length === 0) return 0;
  return Math.min(1, ticket.rails.length / ticket.scope.length);
}
