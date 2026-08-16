// record.mjs — capture a PASSING spec-lint result into the gate-manifest
// evidence ledger, bound to the ticket and the spec file (P1 D4: without a
// ticket binding, one ticket's spec-lint pass can satisfy another ticket's
// P1 gate — see packages/runner/lib/assertions.mjs).
//
// Unlike coldstart/premortem/parallax, spec-lint's core check is
// deterministic (no LLM verdict for an operator to answer), so there is no
// operator text to capture — recording just states the tool's own computed
// result, gated on the caller actually having reached the passing exit path.

import { record } from '@adlc/gate-manifest/lib/record.mjs';

export const GATE_NAME = 'spec-lint';

/**
 * Record a passing spec-lint result.
 *
 * @param {object} opts
 * @param {string} opts.ticket    ticket id this spec belongs to (required —
 *   an unbound record can satisfy any ticket's P1 gate)
 * @param {string} opts.specPath  path to the linted spec file (hashed via
 *   gate-manifest's --files mechanism, same as spec-approval)
 * @param {string} [opts.dir]     ledger directory (default .adlc)
 * @param {string|null} [opts.key]  HMAC signing key
 * @returns the recorded manifest entry
 */
export function recordResult({ ticket, specPath, dir, key = null } = {}) {
  const rawData = JSON.stringify({ verified: true });
  return record({ gate: GATE_NAME, ticket, rawData, rawFiles: specPath, dir, key });
}
