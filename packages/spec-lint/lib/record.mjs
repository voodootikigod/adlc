// record.mjs — capture a PASSING spec-lint result into the gate-manifest
// evidence ledger, bound to the ticket and the spec file (P1 D4: without a
// ticket binding, one ticket's spec-lint pass can satisfy another ticket's
// P1 gate — see packages/runner/lib/assertions.mjs).
//
// Unlike coldstart/premortem/parallax, spec-lint's core check is
// deterministic (no LLM verdict for an operator to answer), so there is no
// operator text to capture — recording just states the tool's own computed
// result, gated on the caller actually having reached the passing exit path.

import { appendManifestEntry } from '@adlc/gate-manifest/lib/record.mjs';
import { hashFiles, ADLC_DIR } from '@adlc/core';

export const GATE_NAME = 'spec-lint';

/**
 * Record a passing spec-lint result.
 *
 * @param {object} opts
 * @param {string} opts.ticket    ticket id this spec belongs to (required —
 *   an unbound record can satisfy any ticket's P1 gate)
 * @param {string} opts.specPath  path to the linted spec file (hashed directly
 *   into manifest entry files, avoiding comma-splitting of rawFiles)
 * @param {string} [opts.dir]     ledger directory (default .adlc)
 * @param {string|null} [opts.key]  HMAC signing key
 * @returns the recorded manifest entry
 */
export function recordResult({ ticket, specPath, dir = ADLC_DIR, key = null } = {}) {
  const payload = {
    gate: GATE_NAME,
    ticket,
    data: { verified: true },
    files: specPath ? hashFiles([specPath]) : {},
  };
  return appendManifestEntry(payload, dir, { signatureVersion: 1, key });
}
