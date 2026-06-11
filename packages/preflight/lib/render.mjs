// preflight/lib/render.mjs — output formatting for check results.

// Status symbols for human-readable table
const STATUS_SYMBOL = {
  pass: 'PASS',
  fail: 'FAIL',
  skipped: 'SKIP',
};

const STATUS_ICON = {
  pass: '✓',
  fail: '✗',
  skipped: '–',
};

/**
 * Render results as a human-readable table.
 * @param {Array<{name, status, detail}>} results
 * @returns {string[]} lines
 */
export function renderTable(results) {
  const lines = [];

  // Column widths
  const nameWidth = Math.max(5, ...results.map((r) => r.name.length));
  const statusWidth = 6;

  const divider = `${'─'.repeat(nameWidth + statusWidth + 6)}`;
  const header = `${'check'.padEnd(nameWidth)}  ${'status'.padEnd(statusWidth)}  detail`;

  lines.push(divider);
  lines.push(header);
  lines.push(divider);

  for (const r of results) {
    const icon = STATUS_ICON[r.status] ?? '?';
    const statusLabel = (STATUS_SYMBOL[r.status] ?? r.status).padEnd(statusWidth);
    // Only show first line of detail in the table row
    const firstLine = (r.detail ?? '').split('\n')[0];
    lines.push(`${r.name.padEnd(nameWidth)}  ${icon} ${statusLabel}  ${firstLine}`);
    // Indent remaining lines (multi-line detail e.g. tail of test-cmd output)
    const rest = (r.detail ?? '').split('\n').slice(1);
    for (const l of rest) {
      lines.push(`${''.padEnd(nameWidth)}  ${''.padEnd(statusWidth + 3)}  ${l}`);
    }
  }

  lines.push(divider);
  return lines;
}

/**
 * Render a single verdict line.
 * @param {'pass'|'fail'} verdict
 * @param {string[]} failedNames
 * @returns {string}
 */
export function renderVerdict(verdict, failedNames) {
  if (verdict === 'pass') {
    return 'verdict: ALL CHECKS PASSED — environment is ready.';
  }
  return `verdict: FAILED — required checks did not pass: ${failedNames.join(', ')}`;
}

/**
 * Determine overall verdict.
 * Exit 2 if any REQUIRED check fails OR any explicitly requested optional check fails.
 * @param {Array<{name, status, required}>} results
 * @returns {{ verdict: 'pass'|'fail', failedNames: string[] }}
 */
export function computeVerdict(results) {
  const failedNames = results
    .filter((r) => r.status === 'fail' && r.required !== false)
    .map((r) => r.name);
  return {
    verdict: failedNames.length > 0 ? 'fail' : 'pass',
    failedNames,
  };
}
