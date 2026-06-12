// record.mjs — build and append a manifest entry.
// IMPORTANT: chain integrity depends on sha256(raw previous line bytes),
// so we read the ledger file directly via readFileSync — never via readEntries
// which parses and re-serialises, losing byte-exact fidelity.

import { existsSync, readFileSync } from 'node:fs';
import { sha256, hashFiles, appendEntry, ledgerPath, ADLC_DIR } from '../../core/index.mjs';
import { getKey, signEntry } from './sign.mjs';

/**
 * Parse JSON data from a --data flag string.
 * Returns parsed object or throws with a clear message.
 */
export function parseData(raw) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`--data is not valid JSON: ${err.message}`);
  }
}

/**
 * Parse a comma-separated file list from --files flag string.
 * Returns array of trimmed non-empty paths.
 */
export function parseFileList(raw) {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Read the last raw line (non-empty) from a ledger file.
 * Returns null if the file does not exist or has no non-empty lines.
 */
export function readLastRawLine(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf8');
  // Split on newline but keep exact bytes by splitting the buffer
  const lines = content.split('\n');
  // Walk backwards to find the last non-empty line
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i];
  }
  return null;
}

/**
 * Build a new manifest entry object (pure, side-effect-free).
 *
 * @param {object} opts
 * @param {string} opts.gate        gate name
 * @param {string|undefined} opts.ticket  ticket id (optional)
 * @param {object|undefined} opts.data   parsed JSON data (optional)
 * @param {string[]} opts.filePaths  list of files to hash
 * @param {string|null} opts.prevRawLine  raw bytes of the previous JSONL line (or null)
 * @param {number} opts.prevSeq     sequence number of previous entry (0 if none)
 * @param {string} opts.ts          ISO timestamp
 * @param {string|null} [opts.key]  HMAC signing key; when present, entry gets a `sig`
 * @returns manifest entry object
 */
export function buildEntry({ gate, ticket, data, filePaths, prevRawLine, prevSeq, ts, key = null }) {
  const entry = {
    seq: prevSeq + 1,
    gate,
    ts,
  };

  if (ticket !== undefined) entry.ticket = ticket;
  if (data !== undefined) entry.data = data;

  entry.files = filePaths.length > 0 ? hashFiles(filePaths) : {};
  entry.prev = prevRawLine !== null ? sha256(prevRawLine) : null;

  // Sign last: `sig` is computed over the canonical bytes of all other fields
  // (see sign.mjs) and appended as the final field so it is excluded from the
  // signed payload. Without a key the entry is unsigned and verify will flag it.
  if (key) entry.sig = signEntry(key, entry);

  return entry;
}

/**
 * Record a new entry in the manifest ledger.
 *
 * @param {object} opts
 * @param {string} opts.gate
 * @param {string|undefined} opts.ticket
 * @param {string|undefined} opts.rawData   raw --data string (parsed here)
 * @param {string|undefined} opts.rawFiles  raw --files string (parsed here)
 * @param {string} [opts.dir]  ledger directory (default ADLC_DIR)
 * @returns the recorded entry object
 * @throws Error for malformed --data JSON
 */
export function record({ gate, ticket, rawData, rawFiles, dir = ADLC_DIR }) {
  const data = parseData(rawData);
  const filePaths = parseFileList(rawFiles);

  const lp = ledgerPath('manifest', dir);
  const prevRawLine = readLastRawLine(lp);

  // Determine previous seq by parsing the last raw line if present
  let prevSeq = 0;
  if (prevRawLine !== null) {
    try {
      const parsed = JSON.parse(prevRawLine);
      prevSeq = typeof parsed.seq === 'number' ? parsed.seq : 0;
    } catch {
      // Malformed last line; still record but seq continues from 0
    }
  }

  const ts = new Date().toISOString();
  const key = getKey();
  const entry = buildEntry({ gate, ticket, data, filePaths, prevRawLine, prevSeq, ts, key });

  appendEntry('manifest', entry, dir);
  return entry;
}
