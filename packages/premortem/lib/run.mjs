// lib/run.mjs — orchestrate the full premortem flow (read spec, call LLM, render).

import { readFileSync, writeFileSync } from 'node:fs';
import { complete, extractJson, detectProvider, promptOnly, opError, printJson } from '@adlc/core';
import { buildPrompt, SYSTEM_PROMPT } from './prompt.mjs';
import { renderReport } from './render.mjs';
// verdict.mjs (and the gate-manifest package it pulls in) is imported lazily,
// only when --record-verdict is actually used — see the promptOnlyMode branch
// below — so plain --prompt-only runs never pay for or depend on it.

/**
 * Main premortem flow.
 *
 * @param {object} opts
 * @param {string}  opts.specPath       — path to the spec file
 * @param {string}  [opts.tier]         — model tier (default 'frontier')
 * @param {string}  [opts.outPath]      — if set, write report to this path
 * @param {boolean} [opts.json]         — emit machine-readable JSON
 * @param {boolean} [opts.promptOnlyMode] — print prompt and exit 0 without calling LLM
 * @param {string}  [opts.recordVerdictSource] — with promptOnlyMode: file path (or '-'
 *                  for stdin) to read the operator's verdict from and record into
 *                  the gate-manifest ledger
 * @param {string}  [opts.ticket]       — required alongside recordVerdictSource: an
 *                  unbound premortem record can satisfy any ticket's P1 gate
 */
export async function run(opts) {
  const { specPath, tier = 'frontier', outPath, json, promptOnlyMode, recordVerdictSource, ticket, key = null } = opts;

  if (recordVerdictSource !== undefined && !ticket) {
    opError('--record-verdict requires --ticket (an unbound premortem record cannot count as this ticket\'s P1 evidence)');
  }

  // --- read spec ---
  let specContent;
  try {
    specContent = readFileSync(specPath, 'utf8');
  } catch (err) {
    opError(`cannot read spec file '${specPath}': ${err.message}`);
  }

  // A positive policy, not a deny-list: trim() strips White_Space only, and
  // every deny-list of "invisible" code points (zero-width spaces, BOMs,
  // controls, combining marks, the Braille blank, ...) has a next member.
  // A specification must contain at least one letter or digit that is not a
  // Default_Ignorable_Code_Point (the Hangul fillers U+115F/U+1160/U+3164/
  // U+FFA0 are category Lo yet render blank); otherwise it has no readable
  // content and must not become analyzed P1 evidence.
  const readable = specContent.replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  if (!/[\p{L}\p{N}]/u.test(readable)) {
    opError(`spec content is empty or whitespace-only (no readable letter or digit)`);
  }

  const prompt = buildPrompt(specContent);

  // --prompt-only: print and exit 0
  if (promptOnlyMode) {
    const display =
      `--- system ---\n${SYSTEM_PROMPT}\n\n--- user ---\n${prompt}`;

    if (recordVerdictSource !== undefined) {
      // Print the prompt — same evidence surface as plain --prompt-only —
      // then capture the operator's answer into the gate-manifest ledger so
      // the audit trail shows the gate was answered *and* what it concluded.
      console.log(display);
      const { readVerdictSource, recordVerdict } = await import('./verdict.mjs');
      const verdict = await readVerdictSource(recordVerdictSource);
      const entry = recordVerdict({ verdict, ticket, specPath, extra: { specPath }, key });
      console.log(`gate-manifest: recorded seq=${entry.seq} gate=${entry.gate}`);
      process.exit(0);
    }

    promptOnly(display);
    // promptOnly exits; this line is unreachable
  }

  // Ensure a provider is available before attempting the call
  if (!detectProvider()) {
    opError(
      'no LLM provider configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY\n' +
        'Use --prompt-only to get the prompt without calling the API.'
    );
  }

  // --- call LLM ---
  let rawText;
  try {
    rawText = await complete({
      tier,
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens: 4096,
    });
  } catch (err) {
    opError(`LLM call failed: ${err.message}`);
  }

  // --- extract JSON ---
  let parsed;
  try {
    parsed = extractJson(rawText);
  } catch (err) {
    opError(`could not extract JSON from model response: ${err.message}\n\nRaw response:\n${rawText}`);
  }

  const causes = parsed?.causes;
  if (!Array.isArray(causes) || causes.length === 0) {
    opError('model response did not contain a non-empty causes array');
  }

  // --- emit output ---
  if (json) {
    printJson({ causes });
    return;
  }

  const report = renderReport(causes);

  if (outPath) {
    try {
      writeFileSync(outPath, report, 'utf8');
      console.log(`premortem report written to ${outPath}`);
    } catch (err) {
      opError(`cannot write output file '${outPath}': ${err.message}`);
    }
  } else {
    process.stdout.write(report);
  }
}
