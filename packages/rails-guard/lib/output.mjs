// Human-readable and JSON output formatters for rails-guard results.

/**
 * Format a violations list as human-readable text.
 *
 * A rail-edit names its OWNING ticket when that is not the ticket the run was asked
 * about (#1050): rails are frozen for everyone, and the operator's remedy for someone
 * else's rail is to go ask, not to sign. With no `--ticket` every owner is named.
 *
 * @param {Array} violations
 * @param {{ticketId?: string|null}} [opts] the --ticket id, when one was given
 * @returns {string}
 */
export function formatViolations(violations, { ticketId = null } = {}) {
  if (violations.length === 0) return 'rails-guard: all checks passed';
  const lines = [`rails-guard: ${violations.length} violation(s) found`];
  for (const v of violations) {
    if (v.type === 'rail-edit') {
      const owner = typeof v.ownerTicket === 'string' && v.ownerTicket !== ticketId
        ? `  (rail of ticket ${v.ownerTicket})`
        : '';
      lines.push(`  [rail-edit]   ${v.file}  (matched globs: ${v.globs.join(', ')})${owner}`);
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
 *
 * `sanctionedAdditions` (#739) is additive disclosure only — it does not change
 * `railsDiffEmpty`'s existing meaning or value (still true whenever there are zero
 * rail-edit violations, exemptions included). Defaults to [] so every existing
 * caller that does not pass it keeps behaving exactly as before.
 *
 * `railSources` (#1050) is the resolved rail set with each glob's declaring ticket
 * (`owner: null` for --rails globs); `railGlobs` stays the de-duplicated string list
 * every existing consumer reads.
 */
export function buildResult({ violations, railGlobs, railSources = [], railGlobError, railsDiffEmpty, suppressionsClean, sanctionedAdditions = [], base, ticket }) {
  return {
    tool: 'rails-guard',
    base: base ?? 'HEAD',
    ticket: ticket?.id ?? null,
    railGlobs,
    railSources,
    railGlobError: railGlobError ?? null,
    railsDiffEmpty,
    suppressionsClean,
    sanctionedAdditions,
    passed: violations.length === 0,
    violations,
  };
}
