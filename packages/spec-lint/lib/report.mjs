// report.mjs — format output for humans and machines.
// Pure functions; no I/O.

/**
 * Build machine-readable JSON result object.
 *
 * @param {Array<{line,text,status,reason}>} classified
 * @param {string} filePath
 * @returns {object}
 */
export function buildJsonResult(classified, filePath) {
  const verified = classified.filter(c => c.status === 'VERIFIED');
  const wishes = classified.filter(c => c.status === 'WISH');
  return {
    file: filePath,
    total: classified.length,
    verified: verified.length,
    wishes: wishes.length,
    criteria: classified.map(c => ({
      line: c.line,
      status: c.status,
      text: c.text,
      reason: c.reason,
    })),
  };
}

/**
 * Format a human-readable table.
 *
 * @param {Array<{line,text,status,reason}>} classified
 * @param {string} filePath
 * @returns {string[]}  Lines to print.
 */
export function buildHumanReport(classified, filePath) {
  const lines = [];
  lines.push(`spec-lint: ${filePath}`);
  lines.push('');

  if (classified.length === 0) {
    lines.push('WARNING: no criteria found in spec.');
    return lines;
  }

  // Column widths.
  const LINE_W = 6;
  const STATUS_W = 8;
  const TEXT_PREVIEW = 52;
  const header =
    padEnd('LINE', LINE_W) + '  ' +
    padEnd('STATUS', STATUS_W) + '  ' +
    padEnd('TEXT', TEXT_PREVIEW) + '  ' +
    'WHY';
  const divider = '-'.repeat(header.length);

  lines.push(header);
  lines.push(divider);

  for (const c of classified) {
    const mark = c.status === 'VERIFIED' ? '✓ PASS' : '✗ WISH';
    const preview = truncate(c.text, TEXT_PREVIEW);
    lines.push(
      padEnd(String(c.line), LINE_W) + '  ' +
      padEnd(mark, STATUS_W) + '  ' +
      padEnd(preview, TEXT_PREVIEW) + '  ' +
      c.reason,
    );
  }

  lines.push(divider);

  const verified = classified.filter(c => c.status === 'VERIFIED').length;
  const wishes = classified.filter(c => c.status === 'WISH').length;
  lines.push(`${classified.length} total  |  ${verified} verified  |  ${wishes} wish(es)`);

  if (wishes > 0) {
    lines.push('');
    lines.push('Wishes (need a verification method):');
    for (const c of classified.filter(c => c.status === 'WISH')) {
      lines.push(`  line ${c.line}: ${c.text}`);
    }
  }

  return lines;
}

function padEnd(str, len) {
  return String(str).padEnd(len);
}

function truncate(str, len) {
  if (str.length <= len) return str;
  return str.slice(0, len - 1) + '…';
}
