/**
 * Human-readable output formatting for merge-forecast.
 */

const VERDICT_COLOR = {
  VETO: '\x1b[31m',     // red
  SEQUENCE: '\x1b[33m', // yellow
  PARALLEL: '\x1b[32m', // green
};
const RESET = '\x1b[0m';

function color(text, code) {
  // Only colorize if stdout is a TTY
  if (!process.stdout.isTTY) return text;
  return `${code}${text}${RESET}`;
}

/**
 * Format the forecast result as human-readable text lines.
 * Returns a multi-line string.
 */
export function formatForecast(result) {
  const lines = [];

  lines.push('');
  lines.push('── Conflict Forecast ─────────────────────────────────────────────');
  lines.push('');

  if (result.pairs.length === 0) {
    lines.push('  No parallel-eligible pairs found (all tickets are serialized by DAG).');
  } else {
    // Header
    lines.push(
      padR('Pair', 18) +
        padR('Score', 8) +
        padR('Signal', 22) +
        'Verdict'
    );
    lines.push('─'.repeat(65));
    for (const p of result.pairs) {
      const v = color(p.verdict, VERDICT_COLOR[p.verdict] ?? '');
      lines.push(
        padR(p.pair, 18) +
          padR(p.score.toFixed(3), 8) +
          padR(p.signal, 22) +
          v
      );
    }
  }

  lines.push('');
  lines.push('── Schedule ──────────────────────────────────────────────────────');
  lines.push('');

  for (let i = 0; i < result.waves.length; i++) {
    const waveTags = result.waves[i].map((id) => {
      const pr = result.pairs.find((p) => p.a === id || p.b === id);
      return id;
    });
    lines.push(`  Wave ${i + 1}: ${waveTags.join(', ')}`);
  }

  lines.push('');
  lines.push(`  Merge order (foundation-first): ${result.mergeOrder.join(' → ')}`);
  lines.push(`  Pull-queue: ${result.pullQueueNote}`);

  lines.push('');
  lines.push('── Width Analysis ────────────────────────────────────────────────');
  lines.push('');
  lines.push(`  Certified width  : ${result.certifiedWidth}`);
  if (result.backpressureWidth !== null) {
    lines.push(`  Backpressure width: ${result.backpressureWidth}`);
  }
  lines.push(`  Recommended width: ${result.recommendedWidth}`);

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('── Warnings ──────────────────────────────────────────────────────');
    for (const w of result.warnings) lines.push(`  ⚠  ${w}`);
  }

  if (result.gateFailures.length > 0) {
    lines.push('');
    lines.push('── Gate Failures ─────────────────────────────────────────────────');
    for (const f of result.gateFailures) lines.push(`  ✗  ${f}`);
  } else {
    lines.push('');
    lines.push('  Gate: PASS');
  }

  lines.push('');
  return lines.join('\n');
}

function padR(str, len) {
  return String(str).padEnd(len);
}
