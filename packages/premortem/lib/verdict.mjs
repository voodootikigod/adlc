// lib/verdict.mjs — capture the operator's self-assessed --prompt-only
// verdict into the gate-manifest evidence ledger (ADLC C11).
//
// In Claude Code (and similar harnesses) premortem runs with --prompt-only:
// the tool prints the failure-mode stress-test prompt, the operator (the
// model itself) answers it and applies judgment, but that verdict never
// entered the audit trail — only the prompt being printed was observable.
// --record-verdict closes that gap by capturing the operator's answer
// alongside the prompt.
//
// This file intentionally does NOT reimplement gate-manifest's hash-chain /
// signing logic — it imports and calls gate-manifest's own record() so that
// logic stays centralized in exactly one place.

import { readFileSync } from 'node:fs';
import { readStdin, opError } from '@adlc/core';
import { record } from '@adlc/gate-manifest/lib/record.mjs';

const GATE_NAME = 'premortem';

/**
 * Read the operator's verdict text from a file path, or from stdin when
 * `source` is exactly '-'.
 *
 * @param {string} source  file path, or '-' for stdin
 * @returns {Promise<string>} trimmed verdict text
 */
export async function readVerdictSource(source) {
  if (source === '-') {
    const text = (await readStdin()).trim();
    if (!text) opError('--record-verdict - : stdin was empty');
    return text;
  }

  let text;
  try {
    text = readFileSync(source, 'utf8');
  } catch (err) {
    opError(`cannot read verdict file '${source}': ${err.message}`);
  }
  text = text.trim();
  if (!text) opError(`--record-verdict ${source}: file was empty`);
  return text;
}

/**
 * Record the operator's prompt-only verdict into .adlc/manifest.jsonl via
 * gate-manifest's record() function.
 *
 * @param {object} opts
 * @param {string} opts.verdict   the operator's answer/conclusion
 * @param {string} [opts.ticket]  ticket id this premortem belongs to — P1 D4:
 *   an unbound record can satisfy any ticket's gate, so the CLI requires this
 * @param {string} [opts.specPath] path to the analyzed spec, hashed into
 *   entry.files (same binding mechanism as spec-lint/spec-approval)
 * @param {object} [opts.extra]   additional context merged into `data`
 * @param {string} [opts.dir]     ledger directory (default .adlc)
 * @returns the recorded manifest entry
 */
export function recordVerdict({ verdict, ticket, specPath, extra = {}, dir, key } = {}) {
  // `usageStatus: 'unreported'` is the T152 vocabulary, and it is literally true
  // here: a real model call was made — by the operator's harness, answering the
  // prompt this gate printed — and its token count is not knowable to this tool.
  // Without it the entry carries no evidence that a call happened at all, and
  // `aggregateSpend` discards it, which is why a --prompt-only workflow used to
  // aggregate to "no recorded usage" after months of real work. NO counters are
  // invented: the entry has no `usage` key, so nothing is booked as free.
  const data = { promptOnly: true, usageStatus: 'unreported', verdict, ...extra };
  return record({ gate: GATE_NAME, ticket, rawData: JSON.stringify(data), rawFiles: specPath, dir, key });
}
