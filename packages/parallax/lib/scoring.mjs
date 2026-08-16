// Divergence scoring and report rendering.
// Pure functions — no I/O, testable offline.

/**
 * Compute the ambiguity score.
 * score = divergences / (divergences + agreements), rounded to 2 dp.
 * Returns 0 if both counts are 0 (nothing to measure → no ambiguity).
 * @param {number} divergenceCount
 * @param {number} agreementCount
 * @returns {number} 0.00 – 1.00
 */
export function computeScore(divergenceCount, agreementCount) {
  const total = divergenceCount + agreementCount;
  if (total === 0) return 0;
  return Math.round((divergenceCount / total) * 100) / 100;
}

/**
 * Render a markdown report from the divergence analysis result.
 * @param {object} params
 * @param {string[]} params.agreements
 * @param {Array<{point: string, options: Array<{label: string, reading: string}>}>} params.divergences
 * @param {number} params.score - pre-computed ambiguity score (0–1)
 * @param {number} params.threshold - gate threshold
 * @returns {string}
 */
export function renderReport({ agreements, divergences, score, threshold }) {
  const lines = [];

  lines.push('## Agreement set (draft spec)');
  if (agreements.length === 0) {
    lines.push('_(no clear agreements found across readings)_');
  } else {
    for (const a of agreements) {
      lines.push(`- ${a}`);
    }
  }

  lines.push('');
  lines.push('## Divergences — answer these');
  if (divergences.length === 0) {
    lines.push('_(none — all readings converged)_');
  } else {
    for (let i = 0; i < divergences.length; i++) {
      const d = divergences[i];
      lines.push('');
      lines.push(`**Q${i + 1}: ${d.point}**`);
      for (const opt of d.options) {
        lines.push(`  ${opt.label}) ${opt.reading}`);
      }
    }
  }

  lines.push('');
  lines.push(`---`);
  lines.push(`**Ambiguity score:** ${score.toFixed(2)} (threshold ${threshold.toFixed(2)}) — gate ${score <= threshold ? 'PASSES ✓' : 'FAILS ✗'}`);

  return lines.join('\n');
}

/**
 * Structured question payload for --questions-json: the machine contract
 * consumed by P1 interrogation flows instead of scraping the markdown report.
 * @param {object} params
 * @param {string} params.mode - 'spec' | 'edge'
 * @param {Array<{point: string, options: Array<{label: string, reading: string}>}>} params.divergences
 * @param {number} params.score
 * @param {number} params.threshold
 * @returns {{mode: string, questions: Array<{point: string, options: Array<{label: string, reading: string}>}>, score: number, threshold: number, gate: boolean}}
 */
export function renderQuestionsJson({ mode, divergences, score, threshold }) {
  const questions = divergences.map((d) => ({ point: d.point, options: d.options }));
  return { mode, questions, score, threshold, gate: score <= threshold };
}

const ROUTE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * Structured question payload for a route conflict (answers not equivalent).
 * @param {string} question
 * @param {string[]} variants
 * @returns {{mode: 'route', questions: Array<{point: string, options: Array<{label: string, reading: string}>}>, gate: false}}
 */
export function renderRouteQuestionsJson(question, variants) {
  return {
    mode: 'route',
    questions: [
      {
        point: question,
        options: variants.map((v, i) => ({ label: ROUTE_LABELS[i] ?? String(i + 1), reading: v })),
      },
    ],
    gate: false,
  };
}

/**
 * Render route mode output when answers are NOT equivalent.
 * @param {string} question
 * @param {string[]} variants
 * @returns {string}
 */
export function renderRouteConflict(question, variants) {
  const lines = [
    `## Route conflict — answer required`,
    '',
    `**Question:** ${question}`,
    '',
    '**Interpretations:**',
  ];
  const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
  variants.forEach((v, i) => {
    lines.push(`  ${labels[i] ?? String(i + 1)}) ${v}`);
  });
  return lines.join('\n');
}
