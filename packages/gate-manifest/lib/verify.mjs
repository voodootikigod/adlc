// verify.mjs — walk raw lines and validate the hash chain.
// Each entry's `prev` must equal sha256(previous raw line).
// Sequence numbers must be strictly monotonically increasing.

import { existsSync, readFileSync } from 'node:fs';
import { sha256, ledgerPath, AIDLC_DIR } from '../../core/index.mjs';

/**
 * Result of a chain verification.
 * @typedef {object} VerifyResult
 * @property {boolean} valid
 * @property {string} message    human-readable summary
 * @property {number} count      number of entries checked
 * @property {object|null} break  null if valid; { seq, lineNo, reason } if broken
 */

/**
 * Verify the manifest ledger's hash chain.
 *
 * Reads raw lines directly (never via readEntries) so that sha256 is computed
 * over the exact bytes that were written.
 *
 * @param {string} [dir]  ledger directory (default AIDLC_DIR)
 * @returns {VerifyResult}
 */
export function verify(dir = AIDLC_DIR) {
  const lp = ledgerPath('manifest', dir);

  if (!existsSync(lp)) {
    return { valid: true, message: 'empty manifest', count: 0, break: null };
  }

  const content = readFileSync(lp, 'utf8');
  const rawLines = content.split('\n');

  // Filter to non-empty lines, keeping original 1-based line numbers
  const nonEmpty = rawLines
    .map((line, i) => ({ line, lineNo: i + 1 }))
    .filter(({ line }) => line.trim() !== '');

  if (nonEmpty.length === 0) {
    return { valid: true, message: 'empty manifest', count: 0, break: null };
  }

  let prevRawLine = null;
  let prevSeq = null;

  for (const { line, lineNo } of nonEmpty) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return {
        valid: false,
        message: `chain broken at line ${lineNo}: malformed JSON`,
        count: lineNo - 1,
        break: { seq: null, lineNo, reason: 'malformed JSON' },
      };
    }

    // Check prev hash
    if (prevRawLine === null) {
      // First entry: prev must be null
      if (entry.prev !== null) {
        return {
          valid: false,
          message: `chain broken at seq ${entry.seq} (line ${lineNo}): first entry prev must be null`,
          count: 0,
          break: { seq: entry.seq, lineNo, reason: 'first entry prev must be null' },
        };
      }
    } else {
      const expected = sha256(prevRawLine);
      if (entry.prev !== expected) {
        return {
          valid: false,
          message: `chain broken at seq ${entry.seq} (line ${lineNo}): prev hash mismatch`,
          count: lineNo - 1,
          break: { seq: entry.seq, lineNo, reason: 'prev hash mismatch' },
        };
      }
    }

    // Check seq monotonicity
    if (prevSeq !== null && entry.seq <= prevSeq) {
      return {
        valid: false,
        message: `chain broken at seq ${entry.seq} (line ${lineNo}): seq must be strictly increasing`,
        count: lineNo - 1,
        break: { seq: entry.seq, lineNo, reason: 'seq not monotonically increasing' },
      };
    }

    prevRawLine = line;
    prevSeq = entry.seq;
  }

  return {
    valid: true,
    message: `manifest ok (${nonEmpty.length} entries)`,
    count: nonEmpty.length,
    break: null,
  };
}
