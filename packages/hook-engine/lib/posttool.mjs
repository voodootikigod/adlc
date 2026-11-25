// posttool.mjs — shared PostToolUse audit and flail-detection evaluation.

import { analyze } from '@adlc/flail-detector/lib/analyze.mjs';

export const DEFAULT_MAX_REPEAT = 3;

/**
 * Evaluate PostToolUse session lines for flail signals (repeated errors,
 * scope violations, edit churn, size/budget limits) using @adlc/flail-detector.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.lines]
 * @param {number} [opts.bytes]
 * @param {string[]} [opts.scopes]
 * @param {number} [opts.maxRepeat]
 * @param {number | null} [opts.maxBytes]
 * @param {number | null} [opts.spentTokens]
 * @param {number | null} [opts.budget]
 * @param {string | null} [opts.cwd]
 * @returns {{ status: 'ok' | 'warn', flailing: boolean, signals: object[], advisory: string | null }}
 */
export function evaluatePostTool({
  lines = [],
  bytes = 0,
  scopes = [],
  maxRepeat = DEFAULT_MAX_REPEAT,
  maxBytes = null,
  spentTokens = null,
  budget = null,
  cwd = null,
} = {}) {
  const analysis = analyze({
    lines,
    bytes,
    scopes,
    maxRepeat,
    maxBytes,
    spentTokens,
    budget,
    cwd,
  });

  if (analysis.verdict !== 'flail') {
    return { status: 'ok', flailing: false, signals: [], advisory: null };
  }

  const labels = analysis.signals.map((s) => s.type).join(', ');
  return {
    status: 'warn',
    flailing: true,
    signals: analysis.signals,
    advisory: `ADLC flail-detector warning: ${labels}`,
  };
}
