// record.mjs — build and append a manifest entry.
// IMPORTANT: chain integrity depends on sha256(raw previous line bytes).
// appendManifestEntry derives that link from appendEntries' byte-exact state
// while holding the ledger lock; parsed/re-serialized entries are never used.

import { existsSync, readFileSync } from 'node:fs';
import { sha256, hashFiles, appendEntries, ADLC_DIR } from '@adlc/core';
import { getKey, signEntry } from './sign.mjs';
import { verify } from './verify.mjs';

const RESERVED_CHAIN_FIELDS = ['seq', 'prev', 'sig', 'sigVersion'];

/**
 * Atomically append an arbitrary top-level evidence entry to the C11 manifest.
 * Sequence allocation and the byte-exact previous-line hash happen under the
 * same ledger lock as the write, so runner and gate evidence share one chain.
 */
export function appendManifestEntry(payload, dir = ADLC_DIR, { signatureVersion = 2 } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('manifest payload must be an object');
  }
  for (const field of RESERVED_CHAIN_FIELDS) {
    if (Object.hasOwn(payload, field)) {
      throw new Error(`manifest payload must not provide reserved chain field: ${field}`);
    }
  }

  const [entry] = appendEntries('manifest', (state) => {
    if (state.skipped.length > 0) {
      throw new Error(`manifest contains malformed JSON at line ${state.skipped[0].line}`);
    }
    if (state.rawLines.length > 0) {
      const integrity = verify(dir);
      if (!integrity.valid) {
        throw new Error(`manifest chain is invalid: ${integrity.message}`);
      }
    }
    const previous = state.entries.at(-1);
    if (previous && (!Number.isInteger(previous.seq) || previous.seq < 1)) {
      throw new Error('manifest tail is not hash-chain compatible: missing positive seq');
    }

    const normalized = {
      ...payload,
      gate: payload.gate ?? payload.type ?? 'evidence',
      ts: payload.ts ?? new Date().toISOString(),
      files: payload.files ?? {},
    };
    const chained = {
      seq: previous ? previous.seq + 1 : 1,
      ...normalized,
      prev: state.lastRawLine === null ? null : sha256(state.lastRawLine),
    };
    const key = getKey();
    if (key) {
      if (signatureVersion === 2) chained.sigVersion = 2;
      chained.sig = signEntry(key, chained);
    }
    return [chained];
  }, dir);
  return entry;
}

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
  const payload = { gate, ts: new Date().toISOString() };
  if (ticket !== undefined) payload.ticket = ticket;
  if (data !== undefined) payload.data = data;
  payload.files = filePaths.length > 0 ? hashFiles(filePaths) : {};
  return appendManifestEntry(payload, dir, { signatureVersion: 1 });
}

/**
 * A one-line, side-effect-free reminder to conclude P6 by completing the ticket
 * (T74). Recording a `p6-accept` verdict is evidence, NOT completion — this
 * bridge never mutates a ticket, it only points the operator at the command that
 * does. Returns null when the gate is not a P6 acceptance gate or no ticket was
 * named, so there is nothing to remind about. The `p6-accept` prefix also matches
 * the `p6-acceptance-packet` gate the acceptance path records.
 *
 * @param {string} gate  the recorded gate name
 * @param {string|undefined} ticket  the --ticket id, if any
 * @returns {string|null}
 */
export function ticketCompletionReminder(gate, ticket) {
  if (typeof gate !== 'string' || typeof ticket !== 'string' || ticket === '') return null;
  if (!/^p6-accept/.test(gate)) return null;
  return `reminder: recording ${gate} is evidence, not completion — conclude P6 with ` +
    `\`adlc ticket complete ${ticket} --write\` (add \`--authorize\` when the ticket is railed).`;
}
