// analyzability.mjs — decides whether a parsed log can be analyzed at all.
//
// WHY THIS EXISTS (issue #622). `analyze()` answers "did any flail signal
// fire?" — and for a log that yielded nothing to look at, the honest answer to
// THAT question is "no", which the CLI used to render as CLEAN, exit 0, and
// (with --record) a signed `flail-check` manifest entry that satisfies the P4
// supervisor requirement. A supervisor pointed at a log path that was never
// written therefore got a green gate and permanent evidence for a session
// nobody analyzed. "Nothing to analyze" is an operational state, not a verdict:
// this module names it so the CLI can refuse to record and exit 1.
//
// Scope is deliberately NOT part of this decision. A well-behaved session may
// contain no writes at all, and a supervisor (e.g. @adlc/fleet) passes the
// ticket's --scope on every consult — so "lines but no extractable path" is a
// normal clean log, not an unanalyzable one: repeated-error, size and budget
// signals still run on it and the scope signals simply have nothing to flag.
// Under-extraction of paths from real logs is issue #623's domain.
//
// Pure and deterministic; never mutates its inputs.

export const REASON_NO_LINES =
  'log has no non-empty lines (empty or whitespace-only file)';

/**
 * Assess whether the parsed log carries anything to analyze.
 *
 * Not analyzable when the log has zero non-empty lines (empty or
 * whitespace-only file).
 *
 * @param {object} opts
 * @param {string[]} opts.lines - text lines from parseLog
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function assessAnalyzability({ lines }) {
  const nonEmpty = lines.filter((line) => typeof line === 'string' && line.trim().length > 0);
  const reasons = nonEmpty.length === 0 ? [REASON_NO_LINES] : [];
  return { ok: reasons.length === 0, reasons };
}
