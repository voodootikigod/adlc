// review-calibration/lib/report.mjs
// Human-readable and JSON output for review-calibration scorecards.

/**
 * Build the machine-readable JSON report object.
 *
 * @param {{
 *   recall:number, caught:number, total:number,
 *   precision:number, truePositives:number, falsePositives:number,
 *   perCategory:{[cat:string]:{caught:number,total:number,recall:number}},
 *   results:Array<{file,line,category,operator,caught,original,mutated}>,
 *   reviewExitCode:number|null, commit:string, minRecall:number,
 *   minPrecision?:number, scorer:string, judgeAgreement?:number,
 *   equivalentExcluded?:number
 * }} scorecard
 * @returns {object}
 */
export function buildJsonReport(scorecard) {
  const recallPass = scorecard.recall >= scorecard.minRecall;
  const precisionPass =
    scorecard.minPrecision == null || scorecard.precision >= scorecard.minPrecision;
  return {
    recall: scorecard.recall,
    caught: scorecard.caught,
    total: scorecard.total,
    precision: scorecard.precision,
    truePositives: scorecard.truePositives,
    falsePositives: scorecard.falsePositives,
    minRecall: scorecard.minRecall,
    minPrecision: scorecard.minPrecision ?? null,
    gatePass: recallPass && precisionPass,
    scorer: scorecard.scorer,
    judgeAgreement: scorecard.judgeAgreement ?? null,
    equivalentExcluded: scorecard.equivalentExcluded ?? 0,
    commit: scorecard.commit,
    reviewExitCode: scorecard.reviewExitCode,
    perCategory: scorecard.perCategory,
    plants: scorecard.results.map((r) => ({
      file: r.file,
      line: r.line,
      category: r.category ?? r.operator,
      operator: r.operator,
      status: r.caught ? 'caught' : 'missed',
      original: r.original,
      mutated: r.mutated,
    })),
  };
}

/**
 * Print a human-readable scorecard to stdout.
 */
export function printScorecard(scorecard) {
  const {
    recall, caught, total, precision, falsePositives, perCategory, results,
    commit, minRecall, minPrecision, scorer, judgeAgreement, equivalentExcluded,
  } = scorecard;
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const recallPass = recall >= minRecall;
  const precisionPass = minPrecision == null || precision >= minPrecision;
  const pass = recallPass && precisionPass;

  console.log('');
  console.log(`review-calibration — commit ${commit}  [scorer: ${scorer}]`);
  console.log('─'.repeat(60));
  console.log(`Overall recall:  ${pct(recall)}  (${caught}/${total} plants caught)`);
  console.log(`Min recall gate: ${pct(minRecall)}  [${recallPass ? 'PASS' : 'FAIL'}]`);
  console.log(`Precision:       ${pct(precision)}  (${falsePositives} spurious finding(s))`);
  if (minPrecision != null) {
    console.log(`Min precision:   ${pct(minPrecision)}  [${precisionPass ? 'PASS' : 'FAIL'}]`);
  }
  if (judgeAgreement != null) {
    console.log(`Judge agreement: ${pct(judgeAgreement)}  (measured vs labeled fixture)`);
  }
  if (equivalentExcluded) {
    console.log(`Excluded:        ${equivalentExcluded} equivalent mutant(s) (no behavioral discriminator)`);
  }
  console.log('');

  if (Object.keys(perCategory).length > 0) {
    console.log('Per-category breakdown:');
    const maxLen = Math.max(...Object.keys(perCategory).map((k) => k.length));
    for (const [cat, stats] of Object.entries(perCategory)) {
      const bar = stats.total > 0 ? `${stats.caught}/${stats.total}` : '—';
      console.log(`  ${cat.padEnd(maxLen)}  ${pct(stats.recall).padStart(6)}  ${bar}`);
    }
    console.log('');
  }

  console.log('Plants:');
  for (const r of results) {
    const status = r.caught ? 'CAUGHT' : 'MISSED';
    console.log(`  [${status}] ${r.file}:${r.line}  (${r.category ?? r.operator})`);
    if (!r.caught) {
      console.log(`           original: ${r.original.trim()}`);
      console.log(`           mutated:  ${r.mutated.trim()}`);
    }
  }
  console.log('');

  console.log(pass
    ? `GATE PASS — recall ${pct(recall)} meets minimum ${pct(minRecall)}`
    : `GATE FAIL — recall ${pct(recall)} / precision ${pct(precision)} below thresholds`);
  console.log('');
}
