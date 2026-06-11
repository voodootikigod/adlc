// attest.mjs — generate markdown gate evidence for a ticket (PR comment ready).

import { verify } from './verify.mjs';
import { loadFiltered } from './show.mjs';
import { AIDLC_DIR } from '../../core/index.mjs';

/**
 * Summarise the `data` field of an entry for the attest table.
 * Returns a short string.
 */
function dataSummary(data) {
  if (!data || typeof data !== 'object') return '—';
  const keys = Object.keys(data);
  if (keys.length === 0) return '—';
  // Show first two key=value pairs, truncated
  return keys
    .slice(0, 2)
    .map(k => {
      const v = String(data[k]);
      return `${k}=${v.length > 20 ? v.slice(0, 17) + '...' : v}`;
    })
    .join(', ');
}

/**
 * Build the attest markdown for a (possibly filtered) set of entries.
 *
 * @param {object} opts
 * @param {string|undefined} opts.ticket  ticket id to filter on (also used in heading)
 * @param {string} [opts.dir]  ledger directory (default AIDLC_DIR)
 * @returns {string}  markdown text
 */
export function buildAttest({ ticket, dir = AIDLC_DIR } = {}) {
  const { entries } = loadFiltered({ ticket, dir });
  const chainResult = verify(dir);

  const heading = ticket
    ? `## Gate evidence for ${ticket}`
    : '## Gate evidence';

  const lines = [heading, ''];

  if (entries.length === 0) {
    lines.push('_No entries found._', '');
  } else {
    lines.push('| seq | gate | ts | files | data |');
    lines.push('|-----|------|-----|-------|------|');
    for (const e of entries) {
      const fileCount = e.files ? Object.keys(e.files).length : 0;
      const ds = dataSummary(e.data);
      lines.push(`| ${e.seq} | ${e.gate} | ${e.ts} | ${fileCount} | ${ds} |`);
    }
    lines.push('');
  }

  const chainStatus = chainResult.valid
    ? `Chain status: **valid** (${chainResult.count} entries)`
    : `Chain status: **BROKEN** — ${chainResult.message}`;

  lines.push(chainStatus);

  return lines.join('\n');
}
