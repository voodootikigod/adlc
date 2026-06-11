// review-calibration/lib/report.mjs
// Human-readable and JSON output for review-calibration scorecards.

/**
 * Build the machine-readable JSON report object.
 *
 * @param {{
 *   recall: number,
 *   caught: number,
 *   total: number,
 *   falsePositives: number,
 *   perOperator: { [op: string]: { caught: number, total: number, recall: number } },
 *   results: Array<{ file, line, operator, caught, original, mutated }>,
 *   reviewExitCode: number | null,
 *   commit: string,
 *   minRecall: number,
 * }} scorecard
 * @returns {object}
 */
export function buildJsonReport(scorecard) {
  return {
    recall: scorecard.recall,
    caught: scorecard.caught,
    total: scorecard.total,
    falsePositives: scorecard.falsePositives,
    minRecall: scorecard.minRecall,
    gatePass: scorecard.recall >= scorecard.minRecall,
    commit: scorecard.commit,
    reviewExitCode: scorecard.reviewExitCode,
    perOperator: scorecard.perOperator,
    plants: scorecard.results.map((r) => ({
      file: r.file,
      line: r.line,
      operator: r.operator,
      status: r.caught ? 'caught' : 'missed',
      original: r.original,
      mutated: r.mutated,
    })),
  };
}

/**
 * Print a human-readable scorecard to stdout.
 *
 * @param {{
 *   recall: number,
 *   caught: number,
 *   total: number,
 *   falsePositives: number,
 *   perOperator: { [op: string]: { caught: number, total: number, recall: number } },
 *   results: Array<{ file, line, operator, caught, original, mutated }>,
 *   reviewExitCode: number | null,
 *   commit: string,
 *   minRecall: number,
 * }} scorecard
 */
export function printScorecard(scorecard) {
  const { recall, caught, total, falsePositives, perOperator, results, commit, minRecall } = scorecard;
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const pass = recall >= minRecall;

  console.log('');
  console.log(`review-calibration — commit ${commit}`);
  console.log('─'.repeat(60));
  console.log(`Overall recall:  ${pct(recall)}  (${caught}/${total} plants caught)`);
  console.log(`Min recall gate: ${pct(minRecall)}  [${pass ? 'PASS' : 'FAIL'}]`);
  console.log(`False positives: ${falsePositives} (informational — findings not matching any plant)`);
  console.log('');

  // Per-operator breakdown.
  if (Object.keys(perOperator).length > 0) {
    console.log('Per-operator breakdown:');
    const maxOpLen = Math.max(...Object.keys(perOperator).map((k) => k.length));
    for (const [op, stats] of Object.entries(perOperator)) {
      const bar = stats.total > 0 ? `${stats.caught}/${stats.total}` : '—';
      console.log(`  ${op.padEnd(maxOpLen)}  ${pct(stats.recall).padStart(6)}  ${bar}`);
    }
    console.log('');
  }

  // Caught / missed table.
  console.log('Plants:');
  const caught_label = 'CAUGHT';
  const missed_label = 'MISSED';
  for (const r of results) {
    const status = r.caught ? caught_label : missed_label;
    console.log(`  [${status}] ${r.file}:${r.line}  (${r.operator})`);
    if (!r.caught) {
      console.log(`           original: ${r.original.trim()}`);
      console.log(`           mutated:  ${r.mutated.trim()}`);
    }
  }
  console.log('');

  if (!pass) {
    console.log(`GATE FAIL — recall ${pct(recall)} is below minimum ${pct(minRecall)}`);
  } else {
    console.log(`GATE PASS — recall ${pct(recall)} meets minimum ${pct(minRecall)}`);
  }
  console.log('');
}
