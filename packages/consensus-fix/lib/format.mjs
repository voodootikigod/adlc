/**
 * format.mjs — Human-readable output for consensus-fix results.
 * Pure: no I/O.
 */

/**
 * Format the result of a consensus-fix run as human-readable text.
 */
export function formatReport({
  survivors,
  discarded,
  failed,
  groups,
  allDivergent,
  selectionResult,
  railsChecked = true,
  applied,
  dryRun,
}) {
  const lines = [];
  lines.push(`consensus-fix report`);
  lines.push(`--------------------`);
  lines.push(`Regression gate  : ${railsChecked ? 'rails checked (--rails)' : 'NOT CHECKED'}`);
  lines.push(`Candidates total : ${survivors.length + failed.length + discarded.length}`);
  lines.push(`  Passed (survivors) : ${survivors.length}${railsChecked ? ' (repro + rails)' : ' (repro only)'}`);
  lines.push(`  Failed         : ${failed.length}`);
  lines.push(`  Discarded      : ${discarded.length}`);

  if (!railsChecked) {
    lines.push('');
    lines.push('⚠  WARNING: no --rails command supplied. Candidates were checked');
    lines.push('   ONLY against --test-cmd (the repro), NOT the full rail suite. A');
    lines.push('   fix that reddens other tests/types can still survive. Pass');
    lines.push('   --rails "<full suite>" to close this regression gate (C7).');
  }

  if (discarded.length > 0) {
    lines.push('');
    lines.push('Discarded candidates:');
    for (const d of discarded) {
      lines.push(`  [${d.index + 1}] ${d.reason}`);
    }
  }

  if (survivors.length === 0) {
    lines.push('');
    lines.push('No survivors — gate fails.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`Agreement groups : ${groups.size}`);
  for (const group of groups.values()) {
    const indices = group.map((c) => c.index + 1).join(', ');
    lines.push(`  Group (${group.length} member${group.length !== 1 ? 's' : ''}): candidates [${indices}]`);
  }

  if (allDivergent) {
    lines.push('');
    lines.push('⚠  ALL-DIVERGENT: Every survivor is in its own group.');
    lines.push('   This indicates spec ambiguity — escalate to human review.');
  }

  if (selectionResult) {
    const { winner, largestGroupSize } = selectionResult;
    lines.push('');
    lines.push(`Winner: candidate [${winner.index + 1}]`);
    lines.push(`  Agreement group size : ${largestGroupSize}`);
    lines.push(`  Changed lines        : ${winner.changedLines}`);
    lines.push('');

    if (winner.changes.length === 0) {
      lines.push('  No file changes in winning candidate.');
    } else {
      lines.push('  Files changed:');
      for (const { file } of winner.changes) {
        lines.push(`    ${file}`);
      }
    }

    lines.push('');
    if (dryRun) {
      lines.push('Dry-run mode: use --apply to write the winning fix.');
    } else if (applied) {
      lines.push('Winning fix has been applied.');
    }
  }

  return lines.join('\n');
}

/**
 * Format a JSON-serializable result object.
 */
export function formatJson({
  survivors,
  discarded,
  failed,
  groups,
  allDivergent,
  selectionResult,
  railsChecked = true,
  applied,
}) {
  const groupSummary = [];
  let gi = 0;
  for (const group of groups.values()) {
    groupSummary.push({
      groupIndex: gi++,
      size: group.length,
      candidateIndices: group.map((c) => c.index),
    });
  }

  return {
    summary: {
      total: survivors.length + failed.length + discarded.length,
      passed: survivors.length,
      failed: failed.length,
      discarded: discarded.length,
      groups: groups.size,
      allDivergent,
      railsChecked,
    },
    groups: groupSummary,
    winner: selectionResult
      ? {
          index: selectionResult.winner.index,
          changedLines: selectionResult.winner.changedLines,
          largestGroupSize: selectionResult.largestGroupSize,
          changes: selectionResult.winner.changes,
          applied,
        }
      : null,
    discardedDetails: discarded.map((d) => ({ index: d.index, reason: d.reason })),
  };
}
