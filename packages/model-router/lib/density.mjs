/**
 * Rail density computation.
 *
 * railDensity = (rails.length) / max(1, scope.length)  clamped to [0, 1]
 * If the ticket has no rails array, density = 0.
 */

/** Compute the rail density for a single ticket. */
export function railDensity(ticket) {
  if (!ticket.rails || ticket.rails.length === 0) return 0;
  const scopeLen = Array.isArray(ticket.scope) ? ticket.scope.length : 0;
  return Math.min(1, ticket.rails.length / Math.max(1, scopeLen));
}
