// Gap-report rendering for the coldstart gate.
// Pure functions — no I/O, no side effects.

/**
 * A single ticket's result.
 * @typedef {{ id: string, gaps: Array<{what: string, why_blocking: string}> }} TicketResult
 */

/**
 * Render a human-readable report for one or more ticket results.
 * Returns a string (no trailing newline).
 */
export function renderReport(results) {
  const lines = [];
  for (const { id, gaps } of results) {
    if (gaps.length === 0) {
      lines.push(`[PASS] ${id}: ticket is fully executable`);
    } else {
      lines.push(`[FAIL] ${id}: ${gaps.length} gap(s)`);
      for (const gap of gaps) {
        lines.push(`  - ${gap.what}: ${gap.why_blocking}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Build the machine-readable JSON structure used when --json is set.
 * Includes a top-level pass/fail verdict.
 */
export function buildJsonOutput(results) {
  const allPass = results.every((r) => r.gaps.length === 0);
  return {
    ok: allPass,
    results: results.map(({ id, gaps }) => ({
      id,
      pass: gaps.length === 0,
      gaps,
    })),
  };
}

/**
 * Aggregate --all results: returns true when every ticket passes (0 gaps).
 */
export function allPass(results) {
  return results.every((r) => r.gaps.length === 0);
}
