// signals.mjs — signal detection logic for flail-detector.
// All functions are pure and deterministic.

import { globMatch } from '@adlc/core';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex to identify error-bearing lines. */
export const ERROR_LINE_RE = /error|exception|failed|cannot|ENOENT/i;

/**
 * Patterns that extract file paths from common tool-log formats:
 *   Writing <path>
 *   Editing <path>
 *   Created <path>
 *   file_path":"<path>
 */
const PATH_EXTRACT_PATTERNS = [
  /^(?:Writing|Editing|Created)\s+([^\s]+)/i,
  /"file_path"\s*:\s*"([^"]+)"/,
];

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an error line for signature comparison:
 *   1. Lowercase
 *   2. Strip digit sequences
 *   3. Strip hex sequences (0x…)
 *   4. Strip quoted strings
 *   5. Strip absolute paths (/foo/bar or C:\foo\bar)
 *   6. Collapse whitespace
 */
export function normalizeError(line) {
  return line
    .toLowerCase()
    // strip hex literals
    .replace(/0x[0-9a-f]+/gi, '')
    // strip quoted strings (double or single)
    .replace(/"[^"]*"/g, '')
    .replace(/'[^']*'/g, '')
    // strip absolute paths (unix and windows)
    .replace(/(?:\/[^\s/][^\s]*|[A-Za-z]:\\[^\s]*)/g, '')
    // strip digit sequences
    .replace(/\d+/g, '')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Path extraction
// ---------------------------------------------------------------------------

/**
 * Extract a file path from a log line using known tool-log patterns.
 * Returns the path string, or null if none found.
 */
export function extractPath(line) {
  for (const re of PATH_EXTRACT_PATTERNS) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signal detectors
// ---------------------------------------------------------------------------

/**
 * Signal 1: repeated-error
 * Find error-line signatures that appear >= maxRepeat times.
 *
 * @param {string[]} lines
 * @param {number} maxRepeat
 * @returns {{ signature: string, count: number }[]}
 */
export function detectRepeatedErrors(steps, maxRepeat) {
  const counts = new Map();
  const normalizedSteps = steps.map(item => {
    if (typeof item === 'string') return [item];
    if (Array.isArray(item)) return item;
    return [];
  });

  for (const stepLines of normalizedSteps) {
    if (!Array.isArray(stepLines)) continue;
    const stepSigs = new Set();
    for (const line of stepLines) {
      if (typeof line !== 'string' || !ERROR_LINE_RE.test(line)) continue;
      const sig = normalizeError(line);
      if (!sig || sig.length < 5) continue;
      if (/^created at:?$/.test(sig) || /^completed at:?$/.test(sig)) continue;
      stepSigs.add(sig);
    }
    for (const sig of stepSigs) {
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
  }
  const results = [];
  for (const [signature, count] of counts) {
    if (count >= maxRepeat) {
      results.push({ signature, count });
    }
  }
  return results;
}

/**
 * Signal 2: scope violation
 * File paths extracted from the log that do NOT match any scope glob.
 * Only active when scopes are provided.
 *
 * @param {string[]} lines
 * @param {string[]} scopes - glob patterns from --scope flags
 * @returns {{ path: string, line: string }[]}
 */
export function detectScopeViolations(lines, scopes) {
  if (!scopes || scopes.length === 0) return [];
  const violations = [];
  for (const line of lines) {
    const path = extractPath(line);
    if (!path) continue;
    const inScope = scopes.some((g) => globMatch(g, path));
    if (!inScope) {
      violations.push({ path, line: line.trimEnd() });
    }
  }
  return violations;
}

/**
 * Signal 3: edit-churn
 * File paths appearing in >= 3 write/edit log lines.
 *
 * @param {string[]} lines
 * @returns {{ path: string, count: number }[]}
 */
export function detectEditChurn(lines) {
  const counts = new Map();
  for (const line of lines) {
    const path = extractPath(line);
    if (!path) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  const results = [];
  for (const [path, count] of counts) {
    if (count >= 3) {
      results.push({ path, count });
    }
  }
  return results;
}

/**
 * Signal 4: size
 * Log bytes exceed maxBytes.
 *
 * @param {number} bytes
 * @param {number|null} maxBytes - null means no limit
 * @returns {boolean}
 */
export function detectSizeExceeded(bytes, maxBytes) {
  if (maxBytes == null) return false;
  return bytes > maxBytes;
}

/**
 * Signal 5: budget
 * Token spend for this ticket exceeds its declared budget (ADLC.md C6:
 * "token spend past the ticket budget" — one of the two-strike regeneration
 * triggers). Neither figure comes from the log itself: `spentTokens` is
 * measured spend (e.g. from `adlc spend --ticket <id>`) and `budget` is the
 * ticket's declared ceiling (from `ticket.budget`, or model-router's emitted
 * per-ticket budget) — the caller supplies both. Either one absent means
 * there is nothing to compare, so this signal stays silent rather than
 * guessing (issue #275).
 *
 * @param {number|null} spentTokens
 * @param {number|null} budget
 * @returns {boolean}
 */
export function detectBudgetExceeded(spentTokens, budget) {
  if (spentTokens == null || budget == null) return false;
  return spentTokens > budget;
}
