// override.mjs — audited-override recording (issue #48, item 3).
//
// Mirrors the ADLC_RAILS_BYPASS pattern in
// plugins/adlc-claude-code/hooks/adlc-hook.mjs's recordBypass(): a bypass is
// only ever honored if it is durably recorded to the gate-manifest ledger
// FIRST.
//
// This calls @adlc/gate-manifest's own record() directly (the exact function
// backing `adlc gate-manifest record build-gate-bypass`, per
// docs/specs/build-gate-fitness.md) rather than @adlc/core's raw appendEntry.
// The gate-manifest ledger format is hash-chained: every entry needs a
// monotonically increasing `seq` and a `prev` = sha256(previous raw JSONL
// line) (see packages/gate-manifest/lib/record.mjs / verify.mjs). Building a
// raw entry by hand here — without those fields, and without the `gate` key
// verify() expects — corrupts that chain for every entry appended
// afterward, so this package deliberately depends on @adlc/gate-manifest
// (unlike sibling tools with no ledger-writing responsibilities) instead of
// re-deriving its chain/signing logic.

import { record } from '@adlc/gate-manifest/lib/record.mjs';
import { ADLC_DIR } from '@adlc/core';

/**
 * Durably record a build-gate override to .adlc/manifest.jsonl as a
 * 'build-gate-bypass' gate-manifest entry (chain-linked and, when
 * ADLC_MANIFEST_KEY is set, HMAC-signed — exactly like every other entry in
 * the ledger).
 *
 * @param {object} opts
 * @param {string} opts.ticketId
 * @param {string[]} opts.signals - the risk signals that made this ticket high-risk
 * @param {number} opts.depth - the tool-call-count depth signal at override time
 * @param {number} opts.sessionBytes - the transcript-byte signal at override time
 * @param {string} [opts.reason] - free-text reason supplied by the caller
 * @param {string} [opts.dir] - ledger directory (default ADLC_DIR, '.adlc')
 * @returns {boolean} true ONLY if the entry was durably appended; never throws.
 */
export function recordOverride({ ticketId, signals, depth, sessionBytes, reason, dir = ADLC_DIR }) {
  try {
    record({
      gate: 'build-gate-bypass',
      ticket: ticketId ?? undefined,
      rawData: JSON.stringify({
        signals: signals ?? [],
        depth: depth ?? null,
        sessionBytes: sessionBytes ?? null,
        reason: reason ?? null,
      }),
      dir,
    });
    return true;
  } catch {
    // An override that cannot be durably recorded is not a valid override —
    // the caller (decide.mjs via the CLI/hook) must treat this as "refused".
    return false;
  }
}
