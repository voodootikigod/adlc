// Append-only JSONL ledgers under .aidlc/ — the shared persistence layer for
// gate-manifest entries, prosecution findings, routing priors, etc.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const AIDLC_DIR = '.aidlc';

export function ledgerPath(name, dir = AIDLC_DIR) {
  return join(dir, `${name}.jsonl`);
}

/** Append one entry (object) to the named ledger. Creates dir/file as needed. */
export function appendEntry(name, entry, dir = AIDLC_DIR) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(ledgerPath(name, dir), JSON.stringify(entry) + '\n');
  return entry;
}

/**
 * Read all entries. Malformed lines are never silently swallowed: they are
 * returned in `skipped` with line numbers so callers can surface them.
 * Returns { entries, skipped }.
 */
export function readEntries(name, dir = AIDLC_DIR) {
  const p = ledgerPath(name, dir);
  if (!existsSync(p)) return { entries: [], skipped: [] };
  const entries = [];
  const skipped = [];
  const lines = readFileSync(p, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      skipped.push({ line: i + 1, error: String(err.message ?? err) });
    }
  }
  return { entries, skipped };
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/** Hash a list of files → { path: sha256 }. Missing files hash to null. */
export function hashFiles(paths, readFile = (p) => readFileSync(p)) {
  const out = {};
  for (const p of paths) {
    try {
      out[p] = sha256(readFile(p));
    } catch {
      out[p] = null;
    }
  }
  return out;
}
