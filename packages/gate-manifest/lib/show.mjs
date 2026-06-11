// show.mjs — render manifest entries (with optional ticket filter).

import { readEntries, AIDLC_DIR } from '../../core/index.mjs';

/**
 * Load entries from the manifest ledger, optionally filtered by ticket id.
 *
 * @param {object} opts
 * @param {string|undefined} opts.ticket  filter to entries with this ticket id
 * @param {string} [opts.dir]  ledger directory (default AIDLC_DIR)
 * @returns {{ entries: object[], skipped: object[] }}
 */
export function loadFiltered({ ticket, dir = AIDLC_DIR } = {}) {
  const { entries, skipped } = readEntries('manifest', dir);
  const filtered = ticket
    ? entries.filter(e => e.ticket === ticket)
    : entries;
  return { entries: filtered, skipped };
}

/**
 * Render a single entry as a human-readable string array.
 * @param {object} entry
 * @returns {string[]}
 */
export function renderEntry(entry) {
  const lines = [];
  lines.push(`seq=${entry.seq}  gate=${entry.gate}  ts=${entry.ts}`);
  if (entry.ticket) lines.push(`  ticket: ${entry.ticket}`);
  if (entry.data && Object.keys(entry.data).length > 0) {
    lines.push(`  data: ${JSON.stringify(entry.data)}`);
  }
  const fileCount = entry.files ? Object.keys(entry.files).length : 0;
  if (fileCount > 0) {
    lines.push(`  files (${fileCount}):`);
    for (const [path, hash] of Object.entries(entry.files)) {
      lines.push(`    ${path}: ${hash ?? 'null'}`);
    }
  }
  lines.push(`  prev: ${entry.prev ?? 'null'}`);
  return lines;
}

/**
 * Render all entries as human-readable text lines.
 * @param {object[]} entries
 * @returns {string[]}
 */
export function renderEntries(entries) {
  if (entries.length === 0) return ['(no entries)'];
  const out = [];
  for (const e of entries) {
    out.push(...renderEntry(e));
    out.push('');
  }
  return out;
}
