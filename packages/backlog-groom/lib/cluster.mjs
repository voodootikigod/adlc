/**
 * Lane clusters (spec §3.4).
 *
 * Issues whose VERIFIED locations fall in the same profile-declared unit form
 * one cluster — the grouping `issue-lanes` consumes to take N issues from one
 * package.
 *
 * Only verified locations count. An unverified location is not evidence about
 * where the work actually is, and clustering on an unchecked claim would hand a
 * lane a grouping built from what an issue asserted rather than what the code
 * shows.
 *
 * The glob matcher is IMPORTED, not written here. `packages/core/lib/glob.mjs` is
 * the canonical one and a repo guard forbids hand-rolled copies — the regex form
 * people reach for does not terminate in bounded time on a repeated-globstar
 * pattern, which is exactly the shape a rail glob can take.
 */

import { globMatch } from '@adlc/core';

export { globMatch };

/** The profile unit a path belongs to, or null. */
export function unitFor(path, units) {
  for (const u of units ?? []) {
    for (const g of u.paths ?? []) if (globMatch(g, path)) return u.name;
  }
  return null;
}

/**
 * The units an issue's VERIFIED locations sit in.
 *
 * A `moved` verdict carries a real observation — the path is gone — but gives no
 * current location, so it contributes no unit.
 */
export function unitsForIssue(verified, classified, units) {
  if (!verified || !['valid', 'fixed'].includes(verified.verdict)) return [];
  const paths = (classified?.references ?? []).map((r) => r.path);
  return [...new Set(paths.map((p) => unitFor(p, units)).filter(Boolean))];
}

/** Group issues into lane clusters by unit. Issues with no unit are unclustered. */
export function clusterIssues(rows, units) {
  const byUnit = new Map();
  const unclustered = [];
  for (const row of rows ?? []) {
    const inUnits = unitsForIssue(row.verified, row.classified, units);
    // An issue whose verified locations span SEVERAL units is ambiguous, and is
    // left unclustered with its units recorded — the same policy §3.4a already
    // applies to area relabels. Silently filing it under whichever path parsed
    // first would hand a lane package-spanning work labelled as belonging to one
    // package, and hide the other owner entirely.
    if (inUnits.length !== 1) {
      unclustered.push(row.number);
      continue;
    }
    const [unit] = inUnits;
    if (!byUnit.has(unit)) byUnit.set(unit, []);
    byUnit.get(unit).push(row.number);
  }
  return {
    clusters: [...byUnit.entries()]
      .map(([unit, issues]) => ({ unit, issues }))
      .sort((a, b) => a.unit.localeCompare(b.unit)),
    unclustered,
  };
}
