/**
 * The run report (spec §3.9).
 *
 * EVERY RUN LEADS WITH ITS ROUTE DISTRIBUTION — how many issues were verified
 * mechanically, how many by model, and how many not at all. A sweep that
 * mechanically verified 4% of the backlog is still useful, but that number must
 * sit next to the conclusions or a thin run reads as a thorough one. This is the
 * same honesty rule as `truncated`: an incomplete examination must never present
 * as a complete one.
 */

/** Route and verdict tallies, plus the mechanical share. */
export function coverageOf(rows, { truncated = null } = {}) {
  const routes = { mechanical: 0, model: 0, unverifiable: 0 };
  const verdicts = { valid: 0, fixed: 0, moved: 0, unverified: 0, unverifiable: 0 };
  for (const r of rows ?? []) {
    // An issue whose citations were dropped for the budget still carries route
    // `mechanical` — that was the INTENT, not the outcome. Counting intent would
    // report budget overflow as "verified mechanically", which is precisely the
    // thin-run-reads-as-thorough failure the coverage line exists to prevent.
    const intended = r.verified?.route ?? r.classified?.route ?? 'unverifiable';
    const route = r.classified?.referencesTruncated && (r.classified?.references ?? []).length === 0
      ? 'unverifiable'
      : intended;
    if (route in routes) routes[route] += 1;
    const verdict = r.verified?.verdict ?? 'unverifiable';
    if (verdict in verdicts) verdicts[verdict] += 1;
  }
  const total = (rows ?? []).length;
  return {
    total,
    routes,
    verdicts,
    // Reported as a fraction of what was EXAMINED. `truncated` sits beside it so
    // a capped fetch cannot masquerade as a whole-backlog figure.
    mechanicalShare: total === 0 ? 0 : Number((routes.mechanical / total).toFixed(4)),
    truncated,
  };
}

/** Render the report, coverage first. */
export function renderReport(set) {
  const c = set.coverage;
  const lines = [];
  lines.push('# backlog-groom');
  lines.push('');
  lines.push(
    `Examined ${c.total} issue(s): ${c.routes.mechanical} verified mechanically, ` +
      `${c.routes.model} routed to model, ${c.routes.unverifiable} not verifiable ` +
      `(${(c.mechanicalShare * 100).toFixed(1)}% mechanical).`
  );
  if (c.budgetExhausted) {
    lines.push('');
    lines.push(
      '**This run exhausted its citation budget.** Issues past the budget were not verified at all, ' +
        'and are reported unverifiable rather than examined — the run is incomplete.'
    );
  }
  if (c.truncated != null) {
    lines.push('');
    lines.push(
      `**The issue list was TRUNCATED at ${c.truncated}.** This run did not see the whole backlog, ` +
        'and its counts describe only what it fetched.'
    );
  }
  lines.push('');
  lines.push(
    `Verdicts: ${c.verdicts.valid} valid, ${c.verdicts.fixed} fixed, ${c.verdicts.moved} moved, ` +
      `${c.verdicts.unverified} unverified (model route), ${c.verdicts.unverifiable} unverifiable.`
  );

  if (set.relationFilter) {
    const f = set.relationFilter;
    lines.push('');
    lines.push(
      `Relation filter at threshold ${f.threshold}: ${f.pairsSurfaced} of ${f.pairsTotal} pair(s) surfaced for judgment, ` +
        `${f.pairsExcluded} excluded (${(f.excludedRate * 100).toFixed(1)}%). ` +
        'Excluded pairs were never judged, so they bound what this run could have found.'
    );
  }

  lines.push('');
  lines.push(`Clusters: ${set.clusters.length}; unclustered: ${set.unclustered.length}; proposals: ${set.proposals.length}.`);
  return lines.join('\n');
}
