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
// Pure and deterministic; never mutates its inputs.

import { extractPath } from './signals.mjs';

export const REASON_NO_LINES =
  'log has no non-empty lines (empty or whitespace-only file)';
export const REASON_NO_SCOPE_PATHS =
  '--scope was given but no file path could be extracted from the log — scope analysis would be vacuous';

/**
 * Assess whether the parsed log carries enough signal to be analyzed.
 *
 * Not analyzable when:
 *   (a) the log has zero non-empty lines, or
 *   (b) `scopes` is non-empty and no line yields a file path through the SAME
 *       extractor the scope-violation / edit-churn signals use — so the scope
 *       analysis those signals would perform is vacuous, not clean.
 *
 * Both reasons are reported when both apply.
 *
 * @param {object} opts
 * @param {string[]} opts.lines - text lines from parseLog
 * @param {string[]} [opts.scopes] - glob patterns from --scope (empty/absent = no scope check)
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function assessAnalyzability({ lines, scopes = [] }) {
  const nonEmpty = lines.filter((line) => typeof line === 'string' && line.trim().length > 0);
  const scopeRequested = Array.isArray(scopes) && scopes.length > 0;
  const anyPath = scopeRequested && nonEmpty.some((line) => extractPath(line) !== null);

  const reasons = [
    ...(nonEmpty.length === 0 ? [REASON_NO_LINES] : []),
    ...(scopeRequested && !anyPath ? [REASON_NO_SCOPE_PATHS] : []),
  ];

  return { ok: reasons.length === 0, reasons };
}
