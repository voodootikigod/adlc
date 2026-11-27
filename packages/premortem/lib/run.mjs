// lib/run.mjs — orchestrate the full premortem flow (read spec, call LLM, render).

import { readFileSync, writeFileSync } from 'node:fs';
import { complete, extractJson, detectProvider, promptOnly, opError, printJson } from '@adlc/core';
import { buildPrompt, SYSTEM_PROMPT } from './prompt.mjs';
import { renderReport } from './render.mjs';
// verdict.mjs (and the gate-manifest package it pulls in) is imported lazily,
// only when --record-verdict is actually used — see the promptOnlyMode branch
// below — so plain --prompt-only runs never pay for or depend on it.

const FAILING_VERDICT_VALUES = new Set(['fail', 'failed', 'blocked', 'clarify', 'needs-attention', 'ambiguous', 'reject', 'rejected']);

function isFailingRecordedVerdict(verdict) {
  const raw = typeof verdict === 'string' ? verdict.trim() : '';
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const v = typeof parsed.verdict === 'string' ? parsed.verdict.trim().toLowerCase() : '';
      const s = typeof parsed.status === 'string' ? parsed.status.trim().toLowerCase() : '';
      if (FAILING_VERDICT_VALUES.has(v) || FAILING_VERDICT_VALUES.has(s)) return true;
      if (parsed.pass === false || parsed.passed === false || parsed.gate === false || parsed.blocked === true) return true;
      return false;
    }
  } catch { /* plain text verdict */ }
  return /^\s*(?:verdict\s*:\s*)?(?:fail|failed|blocked|clarify|needs-attention|ambiguous|reject|rejected)\b/i.test(raw);
}

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
  const {
    specPath,
    tier = 'frontier',
    maxCauses,
    outPath,
    dir = '.adlc',
    json,
    promptOnlyMode,
    recordVerdictSource,
    ticket,
    provider,
    env = process.env,
  } = opts;
  const rawKey = opts.key !== undefined ? opts.key : (env?.ADLC_MANIFEST_KEY ?? null);
  const key = rawKey === '' ? null : rawKey;

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

  const prompt = buildPrompt(specContent, { maxCauses });

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
      if (!key) {
        console.error('premortem: warning: recording UNSIGNED manifest entry (' + 'ADLC_MANIFEST_KEY' + ' is not set)');
      }
      let entry;
      let verdict;
      try {
        verdict = await readVerdictSource(recordVerdictSource);
        entry = recordVerdict({ verdict, ticket, specPath, extra: { specPath }, dir, key });
      } catch (err) {
        opError(`could not record verdict to manifest ledger: ${err.message}`);
      }
      console.log(`gate-manifest: recorded seq=${entry.seq} gate=${entry.gate}`);
      process.exit(isFailingRecordedVerdict(verdict) ? 2 : 0);
    }

    promptOnly(display);
    // promptOnly exits; this line is unreachable
  }

  // Ensure a provider is available before attempting the call
  if (!detectProvider(env, provider)) {
    opError(
      'no LLM provider configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY\n' +
        'Use --prompt-only to get the prompt without calling the API.'
    );
  }

  // --- call LLM ---
  let rawText;
  let completionMeta = null;
  try {
    rawText = await complete(
      {
        tier,
        provider,
        system: SYSTEM_PROMPT,
        prompt,
        maxTokens: 4096,
        onCompleteMeta: (meta) => {
          completionMeta = meta;
        },
      },
      env,
    );
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

  if (ticket && completionMeta) {
    const { appendManifestEntry, parseData, record } = await import('@adlc/gate-manifest/lib/record.mjs');
    const rawData = JSON.stringify({
      specPath,
      provider: completionMeta.provider,
      model: completionMeta.model,
      tier,
      attestationMode: completionMeta.attestationMode,
      executionWitnessed: true,
      usageStatus: completionMeta.usage ? 'reported' : 'unreported',
      ...(completionMeta.usage ? { usage: completionMeta.usage } : {}),
    });
    try {
      if (specPath && specPath.includes(',')) {
        const { hashFiles } = await import('@adlc/core');
        appendManifestEntry(
          {
            gate: 'premortem',
            ts: new Date().toISOString(),
            ticket,
            data: parseData(rawData),
            files: hashFiles([specPath]),
          },
          dir,
          { signatureVersion: 1, key },
        );
      } else {
        record({ gate: 'premortem', ticket, dir, key, rawFiles: specPath, rawData });
      }
    } catch (err) {
      opError(`could not record premortem to manifest ledger: ${err.message}`);
    }
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
