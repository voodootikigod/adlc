// show.mjs — render manifest entries (with optional ticket filter).

import { ADLC_DIR } from '@adlc/core';
import { readManifestForest } from './forest.mjs';

/**
 * Load entries from the manifest ledger, optionally filtered by ticket id.
 *
 * @param {object} opts
 * @param {string|undefined} opts.ticket  filter to entries with this ticket id
 * @param {string} [opts.dir]  ledger directory (default ADLC_DIR)
 * @returns {{ entries: object[], skipped: object[] }}
 */
export function loadFiltered({ ticket, dir = ADLC_DIR } = {}) {
  const { entries, skipped } = readManifestForest(dir);
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
  // §6: each entry labeled with its segment id. Root entries are unlabeled —
  // a segment-free repo's output must stay byte-identical to the pre-forest
  // renderer (AC2).
  if (entry.segment && entry.segment !== 'root') lines.push(`  segment: ${entry.segment}`);
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
