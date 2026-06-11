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
  applied,
  dryRun,
}) {
  const lines = [];
  lines.push(`consensus-fix report`);
  lines.push(`--------------------`);
  lines.push(`Candidates total : ${survivors.length + failed.length + discarded.length}`);
  lines.push(`  Passed test    : ${survivors.length}`);
  lines.push(`  Failed test    : ${failed.length}`);
  lines.push(`  Discarded      : ${discarded.length}`);

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
  for (const [key, group] of groups.entries()) {
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
