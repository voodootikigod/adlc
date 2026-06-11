// lib/run.mjs — orchestrate the full premortem flow (read spec, call LLM, render).

import { readFileSync, writeFileSync } from 'node:fs';
import { complete, extractJson, detectProvider, promptOnly, opError, printJson } from '../../core/index.mjs';
import { buildPrompt, SYSTEM_PROMPT } from './prompt.mjs';
import { renderReport } from './render.mjs';

/**
 * Main premortem flow.
 *
 * @param {object} opts
 * @param {string}  opts.specPath       — path to the spec file
 * @param {string}  [opts.tier]         — model tier (default 'frontier')
 * @param {string}  [opts.outPath]      — if set, write report to this path
 * @param {boolean} [opts.json]         — emit machine-readable JSON
 * @param {boolean} [opts.promptOnlyMode] — print prompt and exit 0 without calling LLM
 */
export async function run(opts) {
  const { specPath, tier = 'frontier', outPath, json, promptOnlyMode } = opts;

  // --- read spec ---
  let specContent;
  try {
    specContent = readFileSync(specPath, 'utf8');
  } catch (err) {
    opError(`cannot read spec file '${specPath}': ${err.message}`);
  }

  const prompt = buildPrompt(specContent);

  // --prompt-only: print and exit 0
  if (promptOnlyMode) {
    const display =
      `--- system ---\n${SYSTEM_PROMPT}\n\n--- user ---\n${prompt}`;
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
