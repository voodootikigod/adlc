// Report formatting for lesson-foundry — pure functions.

/**
 * Build the human-readable clusters table.
 * clusters: array of { name, route, indices, size }
 * plan: array of emission plan entries
 */
export function buildHumanReport({ clusters, skipped, filtered, plan }) {
  const lines = [];

  if (filtered > 0) {
    lines.push(`  skipped ${filtered} killed finding(s)`);
  }
  if (skipped > 0) {
    lines.push(`  skipped ${skipped} malformed ledger line(s)`);
  }

  if (clusters.length === 0) {
    lines.push('lesson-foundry: no clusters meet the minimum size threshold.');
    return lines;
  }

  lines.push('');
  lines.push('Clusters:');
  lines.push('');

  // Column widths
  const colSize = 6;
  const colRoute = 10;
  const colName = 32;
  const colDest = 48;

  const pad = (s, n) => String(s).padEnd(n).slice(0, n);

  lines.push(
    `  ${pad('SIZE', colSize)} ${pad('ROUTE', colRoute)} ${pad('NAME', colName)} ${pad('DESTINATION', colDest)}`
  );
  lines.push(
    `  ${'-'.repeat(colSize)} ${'-'.repeat(colRoute)} ${'-'.repeat(colName)} ${'-'.repeat(colDest)}`
  );

  for (const cluster of clusters) {
    const p = plan.find((e) => e.cluster === cluster);
    const dest = p?.destination ?? '(dry-run)';
    const sample = cluster.sample ?? '';
    lines.push(
      `  ${pad(cluster.size, colSize)} ${pad(cluster.route, colRoute)} ${pad(cluster.name, colName)} ${pad(dest, colDest)}`
    );
    if (sample) {
      lines.push(`         sample: "${sample.slice(0, 80)}"`);
    }
  }

  lines.push('');
  return lines;
}

/**
 * Build JSON output structure.
 */
export function buildJsonResult({ clusters, skipped, filtered, plan, gateResult }) {
  return {
    skippedMalformed: skipped,
    skippedKilled: filtered,
    clusters: clusters.map((c) => {
      const p = plan.find((e) => e.cluster === c);
      return {
        name: c.name,
        size: c.size,
        route: c.route,
        destination: p?.destination ?? null,
        sample: c.sample,
        indices: c.indices,
      };
    }),
    gate: gateResult ?? null,
  };
}
