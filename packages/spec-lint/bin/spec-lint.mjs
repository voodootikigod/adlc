#!/usr/bin/env node
// spec-lint — ADLC C1 acceptance-criteria gate.
// Usage: spec-lint <spec.md> [--llm] [--tier cheap|mid|frontier] [--json] [--prompt-only]
//                   [--record --ticket <id> [--dir .adlc]]

import { readFileSync } from 'node:fs';
import { parseArgs, pass, gateFail, opError, printJson, promptOnly } from '@adlc/core';
import { parseCriteria } from '../lib/parse.mjs';
import { classifyAll, applyLlmDemotion } from '../lib/classify.mjs';
import { buildJsonResult, buildHumanReport } from '../lib/report.mjs';
import { buildVacuousPrompt, detectVacuous } from '../lib/llm.mjs';
import { recordResult } from '../lib/record.mjs';
import { getKey } from '@adlc/gate-manifest/lib/sign.mjs';

const USAGE = 'usage: spec-lint SPEC.MD [--llm] [--tier cheap|mid|frontier] [--json] [--prompt-only]\n' +
  '                  [--record --ticket ID [--dir .adlc]]';

const { values: flags, positionals } = parseArgs({
  usage: USAGE,
  options: {
    llm: { type: 'boolean', default: false },
    tier: { type: 'string', default: 'cheap' },
    json: { type: 'boolean', default: false },
    'prompt-only': { type: 'boolean', default: false },
    record: { type: 'boolean', default: false },
    ticket: { type: 'string' },
    dir: { type: 'string' },
  },
});

const specPath = positionals[0];

if (!specPath) {
  opError(USAGE);
}

// P1 D4: an unbound spec-lint record can satisfy any ticket's gate (one
// ticket's audit reused for another's approval) — never write one without a
// ticket to bind it to.
if (flags.record && !flags.ticket) {
  opError('--record requires --ticket (an unbound spec-lint record cannot count as this ticket\'s P1 evidence)');
}

const VALID_TIERS = ['cheap', 'mid', 'frontier'];
if (!VALID_TIERS.includes(flags.tier)) {
  opError(`--tier must be cheap|mid|frontier, got: ${flags.tier}`);
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
    llmResult = await detectVacuous(verifiedCriteria, flags.tier);
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
  // Fail closed: a spec with zero recognized acceptance criteria is the strongest
  // under-specification signal, not the absence of one. Criteria placed under an
  // unrecognized heading never parse and land here too — also a gate failure, not
  // a pass. (In --json mode the result body was already printed above.)
  gateFail(
    'spec-lint: no acceptance criteria found. State at least one criterion under a ' +
      'recognized heading (Acceptance Criteria / Requirements), each with a ' +
      'verification method. Zero criteria fails the gate.',
  );
}

if (wishes.length > 0) {
  if (!flags.json) {
    // Already printed in buildHumanReport, but add a summary for non-json.
  }
  gateFail(
    `spec-lint: ${wishes.length} wish(es) found — every criterion needs a verification method.`,
  );
}

// Both fail checks above exit(2) on any problem, so reaching here means a
// genuine pass: every criterion is VERIFIED. Record it now, before the
// process exits, so a real audit leaves real evidence.
if (flags.record) {
  recordResult({ ticket: flags.ticket, specPath, dir: flags.dir, key: getKey() });
}

if (flags.json) {
  process.exit(0);
}
pass('spec-lint: all criteria verified.');
