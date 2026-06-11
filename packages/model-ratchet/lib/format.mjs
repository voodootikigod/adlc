// format.mjs — Human-readable output formatting for model-ratchet.

import { charterLine } from './score.mjs';

/**
 * Format the prosecution plan table.
 *
 * @param {Array<{file, churn, inDegree, score}>} rows
 * @returns {string}
 */
export function formatPlan(rows) {
  if (rows.length === 0) {
    return 'No hot files found (empty churn or no source files).';
  }

  // Compute column widths
  const headers = ['FILE', 'CHURN', 'IN-DEGREE', 'SCORE'];
  const colFile = Math.max(headers[0].length, ...rows.map(r => r.file.length));
  const colChurn = Math.max(headers[1].length, ...rows.map(r => String(r.churn).length));
  const colDeg = Math.max(headers[2].length, ...rows.map(r => String(r.inDegree).length));
  const colScore = Math.max(headers[3].length, ...rows.map(r => String(r.score).length));

  const pad = (s, n) => String(s).padEnd(n);
  const padR = (s, n) => String(s).padStart(n);

  const divider = [
    '-'.repeat(colFile),
    '-'.repeat(colChurn),
    '-'.repeat(colDeg),
    '-'.repeat(colScore),
  ].join('  ');

  const headerLine = [
    pad(headers[0], colFile),
    padR(headers[1], colChurn),
    padR(headers[2], colDeg),
    padR(headers[3], colScore),
  ].join('  ');

  const lines = [
    'model-ratchet — Prosecution Plan',
    '='.repeat(Math.min(80, headerLine.length)),
    headerLine,
    divider,
  ];

  for (const row of rows) {
    lines.push([
      pad(row.file, colFile),
      padR(row.churn, colChurn),
      padR(row.inDegree, colDeg),
      padR(row.score, colScore),
    ].join('  '));
  }

  lines.push('');
  lines.push('Suggested charter lines:');
  for (const row of rows) {
    lines.push(`  ${charterLine(row)}`);
  }

  return lines.join('\n');
}

/**
 * Format the findings summary after running --review-cmd.
 *
 * @param {Array<{file, findings: Array}>} fileResults
 * @returns {string}
 */
export function formatReviewSummary(fileResults) {
  const total = fileResults.reduce((n, r) => n + r.findings.length, 0);
  const lines = [`model-ratchet — Review Run Summary`, ''];
  for (const { file, findings, exitCode, error } of fileResults) {
    if (error) {
      lines.push(`  ${file}: ERROR (${error})`);
    } else {
      lines.push(`  ${file}: exit ${exitCode}, ${findings.length} finding(s)`);
    }
  }
  lines.push('');
  lines.push(`Total findings: ${total}`);
  return lines.join('\n');
}
