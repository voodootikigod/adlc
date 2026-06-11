// format.mjs — human-readable output formatting for flail-detector.

/**
 * Format the analysis result as a human-readable string.
 * @param {object} result - from analyze()
 * @returns {string}
 */
export function formatResult(result) {
  const lines = [];
  const icon = result.verdict === 'flail' ? 'FLAIL' : 'CLEAN';
  lines.push(`flail-detector: ${icon}`);
  lines.push(`  bytes: ${result.bytes}`);

  if (result.signals.length === 0) {
    lines.push('  no flail signals detected');
  } else {
    lines.push('  signals:');
    for (const sig of result.signals) {
      switch (sig.type) {
        case 'repeated-error':
          lines.push(`    repeated-error (${sig.entries.length} signature(s)):`);
          for (const e of sig.entries) {
            lines.push(`      [${e.count}x] ${e.signature}`);
          }
          break;
        case 'scope-violation':
          lines.push(`    scope-violation (${sig.entries.length} path(s) outside scope):`);
          for (const e of sig.entries) {
            lines.push(`      ${e.path}`);
          }
          break;
        case 'edit-churn':
          lines.push(`    edit-churn (${sig.entries.length} file(s) edited >= 3 times):`);
          for (const e of sig.entries) {
            lines.push(`      [${e.count}x] ${e.path}`);
          }
          break;
        case 'size':
          lines.push(`    size: ${sig.bytes} bytes exceeds limit of ${sig.maxBytes} bytes`);
          break;
        default:
          lines.push(`    ${sig.type}`);
      }
    }
  }

  if (result.recommendation) {
    lines.push('');
    lines.push('  recommendation:');
    lines.push(`    ${result.recommendation}`);
  }

  return lines.join('\n');
}
