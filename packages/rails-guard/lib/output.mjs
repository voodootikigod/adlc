// Human-readable and JSON output formatters for rails-guard results.

/**
 * Format a violations list as human-readable text.
 * @param {Array} violations
 * @returns {string}
 */
export function formatViolations(violations) {
  if (violations.length === 0) return 'rails-guard: all checks passed';
  const lines = [`rails-guard: ${violations.length} violation(s) found`];
  for (const v of violations) {
    if (v.type === 'rail-edit') {
      lines.push(`  [rail-edit]   ${v.file}  (matched globs: ${v.globs.join(', ')})`);
    } else if (v.type === 'suppression') {
      lines.push(`  [suppression] ${v.file}:${v.lineNo}  marker: ${v.marker}`);
      if (v.line) lines.push(`                  ${v.line.trim()}`);
    }
  }
  return lines.join('\n');
}

/**
 * Build the structured result object returned in --json mode
 * and also used as the manifest record shape.
 */
export function buildResult({ violations, railGlobs, railGlobError, railsDiffEmpty, suppressionsClean, base, ticket }) {
  return {
    tool: 'rails-guard',
    base: base ?? 'HEAD',
    ticket: ticket?.id ?? null,
    railGlobs,
    railGlobError: railGlobError ?? null,
    railsDiffEmpty,
    suppressionsClean,
    passed: violations.length === 0,
    violations,
  };
}
