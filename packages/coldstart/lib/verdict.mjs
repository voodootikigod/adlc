// lib/verdict.mjs — capture the operator's self-assessed --prompt-only
// verdict into the gate-manifest evidence ledger (ADLC C11).
//
// In Claude Code (and similar harnesses) coldstart runs with --prompt-only:
// the tool prints the audit prompt, the operator (the model itself) answers
// it and applies judgment, but that verdict never entered the audit trail —
// only the prompt being printed was observable. --record-verdict closes that
// gap by capturing the operator's answer alongside the prompt.
//
// This file intentionally does NOT reimplement gate-manifest's hash-chain /
// signing logic — it imports and calls gate-manifest's own record() so that
// logic stays centralized in exactly one place (see CONVENTIONS.md: core is
// frozen, but reuse across sibling packages is expected where a mechanism
// already exists rather than being reinvented).

import { readVerdictSource, recordPromptOnlyVerdict } from '@adlc/core';
import { record } from '@adlc/gate-manifest/lib/record.mjs';

export { readVerdictSource };

/**
 * Record the operator's prompt-only verdict into .adlc/manifest.jsonl via
 * gate-manifest's record() function delegated through @adlc/core.
 *
 * @param {object} opts
 * @param {string|undefined} opts.ticket  ticket id this verdict concerns (optional)
 * @param {string} opts.verdict           the operator's answer/conclusion
 * @param {object} [opts.extra]           additional context merged into `data`
 * @param {string} [opts.dir]             ledger directory (default .adlc)
 * @param {string|null} [opts.key]        optional signing key
 * @returns the recorded manifest entry
 */
export function recordVerdict({
  ticket,
  verdict,
  extra = {},
  dir = '.adlc',
  key,
} = {}) {
  const recordFn = ({ gate, ticket: t, rawData, dir: d }) =>
    record({ gate, ticket: t, rawData, dir: d, key });
  return recordPromptOnlyVerdict({ gate: 'coldstart', ticket, verdict, extra, dir, recordFn });
}
