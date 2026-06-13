#!/usr/bin/env node
// spec-lint — ADLC C1 acceptance-criteria gate.
// Usage: spec-lint <spec.md> [--llm] [--json] [--prompt-only]

import { readFileSync } from 'node:fs';
import { parseArgs, pass, gateFail, opError, printJson, promptOnly } from '@adlc/core';
import { parseCriteria } from '../lib/parse.mjs';
import { classifyAll, applyLlmDemotion } from '../lib/classify.mjs';
import { buildJsonResult, buildHumanReport } from '../lib/report.mjs';
import { buildVacuousPrompt, detectVacuous } from '../lib/llm.mjs';

const { values: flags, positionals } = parseArgs({
  options: {
    llm: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    'prompt-only': { type: 'boolean', default: false },
  },
});

const specPath = positionals[0];

if (!specPath) {
  opError('usage: spec-lint <spec.md> [--llm] [--json] [--prompt-only]');
}

// Read spec file.
let text;
try {
  text = readFileSync(specPath, 'utf8');
} catch {
  opError(`cannot read file: ${specPath}`);
}

// Parse and classify.
const raw = parseCriteria(text);
let classified = classifyAll(raw);

// Collect verified criteria for optional LLM pass.
const verifiedIndices = classified
  .map((c, i) => (c.status === 'VERIFIED' ? i : -1))
  .filter(i => i !== -1);
const verifiedCriteria = verifiedIndices.map(i => classified[i]);

// --prompt-only: print LLM prompt and exit 0.
if (flags['prompt-only']) {
  const prompt = buildVacuousPrompt(verifiedCriteria);
  promptOnly(prompt);
  // promptOnly exits 0; unreachable.
}

// --llm: run vacuous-method detection.
if (flags.llm && verifiedCriteria.length > 0) {
  let llmResult;
  try {
    llmResult = await detectVacuous(verifiedCriteria);
  } catch (err) {
    opError(`LLM call failed: ${err.message}. Use --prompt-only to get the prompt.`);
  }
  classified = applyLlmDemotion(classified, llmResult, verifiedIndices);
}

// Output.
if (flags.json) {
  printJson(buildJsonResult(classified, specPath));
} else {
  const lines = buildHumanReport(classified, specPath);
  for (const l of lines) console.log(l);
}

// Exit codes.
const noCriteria = classified.length === 0;
const wishes = classified.filter(c => c.status === 'WISH');

if (noCriteria) {
  // Warn loudly, but exit 0 (no criteria = nothing to gate on).
  if (!flags.json) {
    console.warn('WARNING: no criteria found — add acceptance criteria to gate on.');
  }
  pass();
}

if (wishes.length > 0) {
  if (!flags.json) {
    // Already printed in buildHumanReport, but add a summary for non-json.
  }
  gateFail(
    `spec-lint: ${wishes.length} wish(es) found — every criterion needs a verification method.`,
  );
}

if (flags.json) {
  process.exit(0);
}
pass('spec-lint: all criteria verified.');
