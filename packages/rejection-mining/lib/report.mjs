// report.mjs — human and JSON output for rejection-mining.
// Pure functions — no I/O.

/**
 * Build the human-readable clusters table.
 *
 * @param {object} opts
 * @param {Array} opts.clusters - cluster objects with slug, title, count, prNumbers
 * @param {Array} opts.lensPlans - planned lens emissions
 * @param {number} opts.totalSignals
 * @param {number} opts.totalPRs
 * @param {number} opts.skippedPRs
 * @returns {string[]}
 */
export function buildHumanReport({ clusters, lensPlans, totalSignals, totalPRs, skippedPRs }) {
  const lines = [];

  lines.push('');
  lines.push('rejection-mining results');
  lines.push('═══════════════════════');
  lines.push(`  PRs scanned:   ${totalPRs}`);
  if (skippedPRs > 0) {
    lines.push(`  PRs skipped:   ${skippedPRs} (fetch errors)`);
  }
  lines.push(`  Signals found: ${totalSignals}`);
  lines.push(`  Lenses:        ${clusters.length}`);
  lines.push('');

  if (clusters.length === 0) {
    lines.push('  No clusters met --min threshold.');
    lines.push('');
    return lines;
  }

  // Table header
  const colW = [30, 7, 5, 40];
  const header = [
    'Title'.padEnd(colW[0]),
    'Signals'.padEnd(colW[1]),
    'PRs'.padEnd(colW[2]),
    'File',
  ].join('  ');
  lines.push('  ' + header);
  lines.push('  ' + '─'.repeat(header.length));

  for (const [idx, cluster] of clusters.entries()) {
    const plan = lensPlans[idx];
    const title = (cluster.title ?? cluster.slug).slice(0, colW[0] - 1).padEnd(colW[0]);
    const count = String(cluster.count).padEnd(colW[1]);
    const prs = String(cluster.prNumbers.size).padEnd(colW[2]);
    const file = plan ? plan.path : '(dry-run)';
    lines.push('  ' + [title, count, prs, file].join('  '));
  }

  lines.push('');

  return lines;
}

/**
 * Build JSON result for --json mode.
 *
 * @param {object} opts
 * @param {Array} opts.clusters
 * @param {Array} opts.lensPlans
 * @param {number} opts.totalSignals
 * @param {number} opts.totalPRs
 * @param {number} opts.skippedPRs
 * @returns {object}
 */
export function buildJsonResult({ clusters, lensPlans, totalSignals, totalPRs, skippedPRs }) {
  return {
    totalPRs,
    skippedPRs,
    totalSignals,
    lensCount: clusters.length,
    lenses: clusters.map((cluster, idx) => {
      const plan = lensPlans[idx] ?? null;
      return {
        slug: cluster.slug,
        title: cluster.title ?? cluster.slug,
        count: cluster.count,
        prCount: cluster.prNumbers.size,
        path: plan ? plan.path : null,
      };
    }),
  };
}
