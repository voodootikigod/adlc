// verify.mjs — walk raw lines and validate the hash chain.
// Each entry's `prev` must equal sha256(previous raw line).
// Sequence numbers must be strictly monotonically increasing.

import { existsSync, readFileSync } from 'node:fs';
import { sha256, ledgerPath, AIDLC_DIR } from '../../core/index.mjs';
import { getKey, verifyEntrySig } from './sign.mjs';

/**
 * Result of a chain verification.
 * @typedef {object} VerifyResult
 * @property {boolean} valid
 * @property {string} message    human-readable summary
 * @property {number} count      number of entries checked
 * @property {boolean} signed    true only when a key was present AND every
 *                               entry verified cryptographically. When no key
 *                               is set this is false: callers MUST NOT claim
 *                               cryptographic provenance from a hash-chain-only
 *                               pass.
 * @property {object|null} break  null if valid; { seq, lineNo, reason } if broken
 */

/**
 * Verify the manifest ledger's hash chain — and, when AIDLC_MANIFEST_KEY is
 * set, the HMAC signature of every entry that carries one.
 *
 * Reads raw lines directly (never via readEntries) so that sha256 is computed
 * over the exact bytes that were written.
 *
 * Security model:
 *  - No key in env  → hash chain checked only; result.signed = false. The chain
 *    proves *internal consistency*, not authorship — a writer can forge it.
 *  - Key in env     → every entry MUST carry a valid sig. A missing sig
 *    ('unsigned entry') or wrong sig ('signature invalid') breaks the chain.
 *    This defeats the forge-from-scratch attack: without the key an attacker
 *    cannot produce valid signatures, so verify (run WITH the key) returns
 *    valid:false.
 *
 * @param {string} [dir]  ledger directory (default AIDLC_DIR)
 * @returns {VerifyResult}
 */
export function verify(dir = AIDLC_DIR) {
  const lp = ledgerPath('manifest', dir);
  const key = getKey();

  if (!existsSync(lp)) {
    return { valid: true, message: 'empty manifest', count: 0, signed: false, break: null };
  }

  const content = readFileSync(lp, 'utf8');
  const rawLines = content.split('\n');

  // Filter to non-empty lines, keeping original 1-based line numbers
  const nonEmpty = rawLines
    .map((line, i) => ({ line, lineNo: i + 1 }))
    .filter(({ line }) => line.trim() !== '');

  if (nonEmpty.length === 0) {
    return { valid: true, message: 'empty manifest', count: 0, signed: false, break: null };
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
        signed: false,
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
          signed: false,
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
          signed: false,
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
        signed: false,
        break: { seq: entry.seq, lineNo, reason: 'seq not monotonically increasing' },
      };
    }

    // Check HMAC signature when a key is configured. With a key, EVERY entry
    // must carry a valid sig — otherwise the chain is not cryptographically
    // attestable and a forged-from-scratch chain would slip through.
    if (key !== null) {
      if (entry.sig === undefined || entry.sig === null) {
        return {
          valid: false,
          message: `chain broken at seq ${entry.seq} (line ${lineNo}): unsigned entry`,
          count: lineNo - 1,
          signed: false,
          break: { seq: entry.seq, lineNo, reason: 'unsigned entry' },
        };
      }
      if (!verifyEntrySig(key, entry)) {
        return {
          valid: false,
          message: `chain broken at seq ${entry.seq} (line ${lineNo}): signature invalid`,
          count: lineNo - 1,
          signed: false,
          break: { seq: entry.seq, lineNo, reason: 'signature invalid' },
        };
      }
    }

    prevRawLine = line;
    prevSeq = entry.seq;
  }

  // signed:true only when a key verified every entry. With no key, the chain
  // is internally consistent but NOT cryptographically attested.
  const signed = key !== null;
  return {
    valid: true,
    message: signed
      ? `manifest ok, signed (${nonEmpty.length} entries)`
      : `manifest ok (${nonEmpty.length} entries)`,
    count: nonEmpty.length,
    signed,
    break: null,
  };
}
