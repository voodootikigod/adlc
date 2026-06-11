// Rail-freeze enforcement: detect edits to frozen rail paths.
// Rails are declared as globs in ticket.rails or supplied via --rails flags.

import { globMatch } from '../../core/lib/tickets.mjs';

/**
 * Resolve the full set of rail globs to enforce.
 *
 * Priority:
 *  1. Explicit --rails flags always win.
 *  2. Otherwise, the ticket's `rails` array (requires --ticket).
 *
 * Returns { globs: string[], error: string | null }
 */
export function resolveRailGlobs(cliRails, ticket) {
  if (cliRails && cliRails.length > 0) {
    return { globs: cliRails, error: null };
  }
  if (!ticket) {
    return { globs: [], error: 'no --rails supplied and no ticket loaded — cannot determine rail globs' };
  }
  const globs = ticket.rails ?? [];
  if (globs.length === 0) {
    return { globs: [], error: `ticket ${ticket.id} has no rails declared` };
  }
  return { globs, error: null };
}

/**
 * Check which changed files match any rail glob.
 * Returns [ { file, type: 'rail-edit', globs: [matched patterns] } ]
 */
export function checkRailEdits(changedFiles, railGlobs) {
  const violations = [];
  for (const file of changedFiles) {
    const matched = railGlobs.filter((g) => globMatch(g, file));
    if (matched.length > 0) {
      violations.push({ file, type: 'rail-edit', globs: matched });
    }
  }
  return violations;
}
