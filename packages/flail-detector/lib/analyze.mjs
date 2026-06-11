// analyze.mjs — orchestrates signal detection and builds the result object.

import {
  detectRepeatedErrors,
  detectScopeViolations,
  detectEditChurn,
  detectSizeExceeded,
} from './signals.mjs';

/**
 * Run all signal detectors against the parsed log.
 *
 * @param {object} opts
 * @param {string[]} opts.lines - text lines from parseLog
 * @param {number} opts.bytes - byte count of the original log
 * @param {string[]} opts.scopes - glob patterns (empty = no scope check)
 * @param {number} opts.maxRepeat - threshold for repeated-error signal
 * @param {number|null} opts.maxBytes - size threshold, or null
 * @returns {AnalysisResult}
 */
export function analyze({ lines, bytes, scopes, maxRepeat, maxBytes }) {
  const repeatedErrors = detectRepeatedErrors(lines, maxRepeat);
  const scopeViolations = detectScopeViolations(lines, scopes);
  const editChurn = detectEditChurn(lines);
  const sizeExceeded = detectSizeExceeded(bytes, maxBytes);

  const isFlail =
    repeatedErrors.length > 0 ||
    scopeViolations.length > 0 ||
    editChurn.length > 0 ||
    sizeExceeded;

  const signals = [];

  if (repeatedErrors.length > 0) {
    signals.push({
      type: 'repeated-error',
      entries: repeatedErrors,
    });
  }

  if (scopeViolations.length > 0) {
    signals.push({
      type: 'scope-violation',
      entries: scopeViolations,
    });
  }

  if (editChurn.length > 0) {
    signals.push({
      type: 'edit-churn',
      entries: editChurn,
    });
  }

  if (sizeExceeded) {
    signals.push({
      type: 'size',
      bytes,
      maxBytes,
    });
  }

  /** @type {string[]|null} */
  let deadEnds = null;
  if (isFlail && repeatedErrors.length > 0) {
    deadEnds = repeatedErrors.map((e) => e.signature);
  }

  return {
    verdict: isFlail ? 'flail' : 'clean',
    signals,
    bytes,
    ...(isFlail && {
      recommendation: buildRecommendation(deadEnds),
    }),
  };
}

/**
 * Build the regenerate recommendation block.
 * @param {string[]|null} deadEnds
 * @returns {string}
 */
function buildRecommendation(deadEnds) {
  if (deadEnds && deadEnds.length > 0) {
    return (
      'Kill the session. Append these dead-ends to the ticket: ' +
      deadEnds.join('; ')
    );
  }
  return 'Kill the session. Review signals above and regenerate fresh.';
}
