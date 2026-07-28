// verify.mjs — walk raw lines and validate the hash chain.
// Each entry's `prev` must equal sha256(previous raw line).
// Sequence numbers must be strictly monotonically increasing.

import { existsSync, readFileSync } from 'node:fs';
import { sha256, ledgerPath, ADLC_DIR } from '@adlc/core';
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
 * Verify the manifest ledger's hash chain — and, when ADLC_MANIFEST_KEY is
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
 *  - requireSignatures:false → tolerate a missing sig only on the LEGACY PREFIX:
 *    entries before the first entry in the file that carries a sig (recorded
 *    before signing was ever enabled on this ledger). Once the scan passes that
 *    first signed entry, every later entry is "signed-era" and a missing sig on
 *    it breaks the chain exactly like strict mode — an attacker cannot regress a
 *    signed ledger back to unsigned by appending plain entries after the fact.
 *    A PRESENT-but-invalid sig is STILL rejected everywhere (tampering), so this
 *    is "an honest unsigned history is OK", not "tampered signatures are OK" or
 *    "unsigned entries are OK anywhere". signed=false.
 *
 *    HONEST LIMIT: if a manifest contains ZERO signed entries, `seenSignedEntry`
 *    never flips, so the WHOLE file is treated as legacy prefix and reported
 *    valid:true. A wholesale-forged, entirely-unsigned chain (sha256 is public
 *    and keyless — this needs no secret) is therefore indistinguishable from an
 *    honest ledger that genuinely predates signing end to end. This mode does
 *    NOT prove "no forgery" in that case, only "no signed entry was tampered
 *    with, and no unsigned entry follows a signed one" — a caller that needs a
 *    stronger guarantee must check for at least one verified signed entry itself
 *    (result.signed alone does not distinguish this: it is false in both the
 *    zero-signed-entries case and the some-signed-entries lenient-pass case).
 *
 * @param {string} [dir]  ledger directory (default ADLC_DIR)
 * @param {object} [opts]
 * @param {boolean} [opts.requireSignatures=true]  when false, tolerate a missing
 *   sig on the contiguous legacy prefix (entries before the first signed entry),
 *   but still reject a missing sig on any entry after that point, and reject any
 *   entry whose PRESENT signature does not verify, anywhere. When true, every
 *   entry must be signed and valid.
 * @returns {VerifyResult}
 */
export function verify(dir = ADLC_DIR, { requireSignatures = true } = {}) {
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
  let seenSignedEntry = false; // set once an entry with a verified sig has been seen

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

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        valid: false,
        message: `chain broken at line ${lineNo}: entry must be an object`,
        count: lineNo - 1,
        signed: false,
        break: { seq: null, lineNo, reason: 'entry must be an object' },
      };
    }

    if (!Number.isInteger(entry.seq) || entry.seq < 1) {
      return {
        valid: false,
        message: `chain broken at line ${lineNo}: seq must be a positive integer`,
        count: lineNo - 1,
        signed: false,
        break: { seq: entry.seq ?? null, lineNo, reason: 'invalid seq' },
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

    // Check HMAC signatures when a key is configured. Two independent conditions:
    //
    //   MISSING sig — gated by requireSignatures AND position. In the default
    //     (true) mode EVERY entry must carry a sig, so a forged-from-scratch chain
    //     is rejected. In the lenient (false) mode a missing sig is tolerated ONLY
    //     while no earlier entry in the file has carried a sig yet — i.e. it is
    //     still inside the contiguous legacy prefix from before signing was ever
    //     enabled on this ledger. As soon as one signed entry has been seen,
    //     `seenSignedEntry` flips true and a later missing sig breaks the chain
    //     just like strict mode: an attacker who controls the tail of a signed
    //     ledger cannot regress it to unsigned by appending plain entries.
    //   PRESENT-but-INVALID sig — rejected in BOTH modes, at ANY position. A sig
    //     that is present but does not verify means the entry's bytes were altered
    //     after signing (or the wrong key signed it). Skipping that in lenient mode
    //     would let an attacker TAMPER a signed entry — e.g. rewrite a signed
    //     `needs-attention` revocation so it no longer matches the gate — recompute
    //     the public prev-hashes, and pass "chain-only" verification. Lenient means
    //     "an honest unsigned prefix is OK", NOT "tampered signatures are OK" and
    //     NOT "unsigned entries are OK anywhere". (Codex #354 re-review F1.)
    if (key !== null) {
      const hasSig = entry.sig !== undefined && entry.sig !== null;
      if (!hasSig) {
        const toleratedLegacyPrefix = !requireSignatures && !seenSignedEntry;
        if (!toleratedLegacyPrefix) {
          return {
            valid: false,
            message: `chain broken at seq ${entry.seq} (line ${lineNo}): unsigned entry`,
            count: lineNo - 1,
            signed: false,
            break: { seq: entry.seq, lineNo, reason: 'unsigned entry' },
          };
        }
      } else {
        if (!verifyEntrySig(key, entry)) {
          return {
            valid: false,
            message: `chain broken at seq ${entry.seq} (line ${lineNo}): signature invalid`,
            count: lineNo - 1,
            signed: false,
            break: { seq: entry.seq, lineNo, reason: 'signature invalid' },
          };
        }
        seenSignedEntry = true;
      }
    }

    prevRawLine = line;
    prevSeq = entry.seq;
  }

  // signed:true only when a key verified every entry. With no key — or when the
  // caller asked for chain-only via requireSignatures:false — the chain is
  // internally consistent but NOT cryptographically attested.
  const signed = key !== null && requireSignatures;
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
