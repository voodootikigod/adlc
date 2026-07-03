// override.mjs — audited-override recording (issue #48, item 3).
//
// Mirrors the ADLC_RAILS_BYPASS pattern in
// plugins/adlc-claude-code/hooks/adlc-hook.mjs's recordBypass(): a bypass is
// only ever honored if it is durably recorded to the gate-manifest ledger
// FIRST. Uses @adlc/core's appendEntry directly (the same primitive
// packages/rails-guard/bin/rails-guard.mjs uses for its own --record path) —
// not the @adlc/gate-manifest package, matching the existing sibling-package
// convention of depending only on @adlc/core, never on another sibling tool.

import { appendEntry, ADLC_DIR } from '@adlc/core';

/**
 * Durably record a build-gate override to .adlc/manifest.jsonl.
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
    appendEntry(
      'manifest',
      {
        ts: new Date().toISOString(),
        type: 'build-gate-bypass',
        ticket: ticketId ?? null,
        signals: signals ?? [],
        depth: depth ?? null,
        sessionBytes: sessionBytes ?? null,
        reason: reason ?? null,
      },
      dir
    );
    return true;
  } catch {
    // An override that cannot be durably recorded is not a valid override —
    // the caller (decide.mjs via the CLI/hook) must treat this as "refused".
    return false;
  }
}
