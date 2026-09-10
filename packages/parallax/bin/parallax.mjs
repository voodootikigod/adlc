#!/usr/bin/env node
// parallax — measured-ambiguity interrogation (ADLC D3)
// Thin CLI: parse args, call lib, exit. No business logic here.

import { readFileSync, existsSync } from 'node:fs';
import {
  parseArgs,
  pass,
  gateFail,
  opError,
  printJson,
  readStdin,
  promptOnly,
  loadTickets,
} from '@adlc/core';
import {
  buildSpecReaderPrompt,
  buildEdgePrompt,
  buildRouteAnswerPrompt,
  buildRouteJudgePrompt,
  buildDivergencePrompt,
} from '../lib/prompts.mjs';
import {
  renderReport,
  renderRouteConflict,
  renderQuestionsJson,
  renderRouteQuestionsJson,
} from '../lib/scoring.mjs';
import { runSpecMode, runEdgeMode, runRouteMode } from '../lib/modes.mjs';
import { getKey } from '@adlc/gate-manifest/lib/sign.mjs';

const USAGE = `parallax — measured-ambiguity interrogation (ADLC D3)

Usage:
  parallax --request "feature request text"
  parallax --file req.md
  echo "request" | parallax
  parallax --edge T1 T2 [--tickets path]
  parallax --route "question" [--context file ...]

Flags:
  --n <int>           fan width (default 3, minimum 2)
  --allow-partial-fan accept a verdict computed from fewer readings than --n
                      requested (some fan calls failed). Off by default: a
                      narrowed sample biases the score toward a pass.
  --threshold <0-1>   ambiguity gate threshold (default 0.25)
  --tier cheap|mid|frontier  override LLM tier
  --json              machine-readable output
  --questions-json    emit open questions as structured JSON
                      ({questions: [{point, options}]}) for interrogation
                      consumers; live mode only, mutually exclusive with
                      --json and --prompt-only
  --prompt-only       print prompts and exit 0 (no API key needed)
  --record-verdict <file|->  with --prompt-only: read the operator's answer
                      from <file> (or stdin when '-') and record it into
                      .adlc/manifest.jsonl via gate-manifest.
                      Requires --ticket — an unbound record can satisfy any
                      ticket's P1 gate
  --ticket <id>       ticket this run is evidence for; binds --record-verdict
  --tickets <path>    tickets file (default .adlc/tickets.json)
  --context <file>    context file(s) for --route mode (repeatable)
  --context-cap <n>   max chars embedded per --context file (default 6000)

Exit codes: 0 = gate passes, 1 = operational error, 2 = gate fails`;

const { values, positionals } = parseArgs({
  usage: USAGE,
  options: {
    // SPEC MODE
    request: { type: 'string', short: 'r' },
    file: { type: 'string', short: 'f' },
    // EDGE MODE
    edge: { type: 'boolean', default: false },
    tickets: { type: 'string' },
    // ROUTE MODE
    route: { type: 'string' },
    context: { type: 'string', multiple: true },
    'context-cap': { type: 'string' },
    // COMMON
    n: { type: 'string', default: '3' },
    'allow-partial-fan': { type: 'boolean', default: false },
    ticket: { type: 'string' },
    threshold: { type: 'string', default: '0.25' },
    tier: { type: 'string' },
    json: { type: 'boolean', default: false },
    'questions-json': { type: 'boolean', default: false },
    'prompt-only': { type: 'boolean', default: false },
    'record-verdict': { type: 'string' },
  },
});

const n = parseInt(values.n, 10);
// A divergence analysis compares readings against each other, so one reading
// can never produce a verdict — `--n 1` used to pass validation, spend an API
// call, and then die on the >=2 guard downstream (#706). Reject it up front.
if (!Number.isInteger(n) || n < 2) {
  opError('--n must be an integer >= 2 (a divergence analysis needs at least two readings to compare)');
}

const threshold = parseFloat(values.threshold);
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  opError('--threshold must be a number between 0 and 1');
}

const VALID_TIERS = ['cheap', 'mid', 'frontier'];
if (values.tier !== undefined && !VALID_TIERS.includes(values.tier)) {
  opError(`--tier must be cheap|mid|frontier, got: ${values.tier}`);
}

if (values['record-verdict'] !== undefined && !values['prompt-only']) {
  opError('--record-verdict requires --prompt-only');
}

// An entry with no ticket binding is evidence for nothing in particular, so it
// can be replayed to satisfy ANY ticket's P1 gate (#709). premortem already
// refuses this; parallax now matches it.
if (values['record-verdict'] !== undefined && values.ticket === undefined) {
  opError('--record-verdict requires --ticket — an unbound record can satisfy any ticket\'s P1 gate');
}

if (values['questions-json'] && values['prompt-only']) {
  opError('--questions-json needs a live divergence analysis; with --prompt-only the questions come from your own answer to the printed prompt');
}
if (values['questions-json'] && values.json) {
  opError('--questions-json and --json are mutually exclusive; pick one output contract');
}

const tierOverride = values.tier ?? undefined;

let contextCap;
if (values['context-cap'] !== undefined) {
  contextCap = parseInt(values['context-cap'], 10);
  if (!Number.isInteger(contextCap) || contextCap < 0) {
    opError(`--context-cap must be a non-negative integer, got: ${values['context-cap']}`);
  }
}

// lib/verdict.mjs (and the @adlc/gate-manifest package it pulls in) is
// imported lazily, only when --record-verdict is actually used, so plain
// --prompt-only runs never pay for or depend on it.
//
// Print `prompts` (same evidence surface as plain --prompt-only), then
// capture the operator's answer into the gate-manifest ledger so the audit
// trail shows the gate was answered *and* what it concluded, and exit 0.
async function recordPromptOnlyVerdict(prompts, extra) {
  for (const [i, p] of prompts.entries()) {
    if (prompts.length > 1) console.log(`--- prompt ${i + 1} of ${prompts.length} ---`);
    console.log(p);
  }
  const { readVerdictSource, recordVerdict } = await import('../lib/verdict.mjs');
  const verdict = await readVerdictSource(values['record-verdict']);
  const entry = recordVerdict({ ticket: values.ticket, verdict, extra, key: getKey() });
  console.log(`gate-manifest: recorded seq=${entry.seq} gate=${entry.gate}`);
  process.exit(0);
}

// --------------------------------------------------------------------------
// EDGE MODE: parallax --edge T1 T2 [--tickets path]
// --------------------------------------------------------------------------
if (values.edge) {
  if (positionals.length < 2) {
    opError('--edge requires two ticket IDs as positional arguments: parallax --edge T1 T2');
  }
  const [idA, idB] = positionals;
  const ticketsPath = values.tickets ?? '.adlc/tickets.json';
  const { tickets, errors: loadErrors } = loadTickets(ticketsPath);

  if (loadErrors.length > 0) {
    opError(`ticket load errors:\n  ${loadErrors.join('\n  ')}`);
  }

  const ticketA = tickets.find((t) => t.id === idA);
  const ticketB = tickets.find((t) => t.id === idB);
  if (!ticketA) opError(`ticket not found: ${idA}`);
  if (!ticketB) opError(`ticket not found: ${idB}`);

  if (values['prompt-only']) {
    const edgeFanPrompt = buildEdgePrompt(ticketA, ticketB);
    const placeholderEdgeReadings = Array.from({ length: n }, (_, i) => ({
      spec: `<reading ${i + 1} spec>`,
      assumptions: [`<assumption ${i + 1}>`],
      decisions: [{ point: `<point ${i + 1}>`, choice: `<choice ${i + 1}>` }],
    }));
    const divergencePrompt = buildDivergencePrompt(placeholderEdgeReadings);

    if (values['record-verdict'] !== undefined) {
      await recordPromptOnlyVerdict([edgeFanPrompt, divergencePrompt], { mode: 'edge', tickets: [idA, idB] });
    }

    promptOnly([edgeFanPrompt, divergencePrompt]);
  }

  let result;
  try {
    result = await runEdgeMode(ticketA, ticketB, {
      n,
      tier: tierOverride ?? 'cheap',
      allowPartialFan: values['allow-partial-fan'],
    });
  } catch (err) {
    opError(err.message);
  }

  const { agreements, divergences, score, errors, requested, used } = result;
  const report = renderReport({ agreements, divergences, score, threshold });

  if (values['questions-json']) {
    printJson({ ...renderQuestionsJson({ mode: 'edge', divergences, score, threshold }), tickets: [idA, idB], requested, used, warnings: errors });
  } else if (values.json) {
    printJson({ mode: 'edge', tickets: [idA, idB], agreements, divergences, score, threshold, gate: score <= threshold, requested, used, warnings: errors });
  } else {
    console.log(`# Edge contract: ${idA} ↔ ${idB}\n`);
    console.log(report);
    if (errors.length > 0) console.error('\nwarnings:', errors.join('; '));
  }

  if (score <= threshold) {
    pass();
  } else {
    gateFail(`edge ambiguity score ${score.toFixed(2)} exceeds threshold ${threshold.toFixed(2)}`);
  }
}

// --------------------------------------------------------------------------
// ROUTE MODE: parallax --route "question" [--context file ...]
// --------------------------------------------------------------------------
if (values.route) {
  const question = values.route;
  const contextPaths = values.context ?? [];
  const contextFiles = [];

  for (const p of contextPaths) {
    if (!existsSync(p)) opError(`context file not found: ${p}`);
    contextFiles.push({ path: p, content: readFileSync(p, 'utf8') });
  }

  if (values['prompt-only']) {
    const answerPrompt = buildRouteAnswerPrompt(question, contextFiles, { contextCap });
    const placeholderAnswers = Array.from({ length: n }, (_, i) => `<answer ${i + 1}>`);
    const judgePrompt = buildRouteJudgePrompt(question, placeholderAnswers);

    if (values['record-verdict'] !== undefined) {
      await recordPromptOnlyVerdict([answerPrompt, judgePrompt], { mode: 'route', question });
    }

    promptOnly([answerPrompt, judgePrompt]);
  }

  let result;
  try {
    result = await runRouteMode(question, contextFiles, {
      n,
      tier: tierOverride ?? 'cheap',
      contextCap,
      allowPartialFan: values['allow-partial-fan'],
    });
  } catch (err) {
    opError(err.message);
  }

  const { equivalent, answer, variants, errors, requested, used } = result;

  if (values['questions-json']) {
    printJson(
      equivalent
        ? { mode: 'route', questions: [], gate: true, answer, requested, used, warnings: errors }
        : { ...renderRouteQuestionsJson(question, variants), requested, used, warnings: errors }
    );
  } else if (values.json) {
    printJson({ mode: 'route', question, equivalent, answer, variants, requested, used, warnings: errors });
  } else if (equivalent) {
    console.log(answer);
    if (errors.length > 0) console.error('\nwarnings:', errors.join('; '));
  } else {
    console.log(renderRouteConflict(question, variants));
    if (errors.length > 0) console.error('\nwarnings:', errors.join('; '));
  }

  if (equivalent) {
    pass();
  } else {
    gateFail('route answers diverge — human decision required');
  }
}

// --------------------------------------------------------------------------
// SPEC MODE (default): --request / --file / stdin
// --------------------------------------------------------------------------

// Determine request text
let request = values.request ?? null;

if (!request && values.file) {
  if (!existsSync(values.file)) opError(`file not found: ${values.file}`);
  request = readFileSync(values.file, 'utf8').trim();
}

if (!request) {
  // Try stdin (non-interactive only)
  if (!process.stdin.isTTY) {
    // Spec mode's request text and `--record-verdict -` both want to drain
    // the same stdin stream. Reading it twice would either (a) starve the
    // verdict read (stdin is already at EOF, so it always looks "empty"
    // and errors out) or (b) if the two were piped together, silently
    // swallow the intended verdict text into the recorded `request` while
    // the verdict read still fails. Fail fast with a clear message instead
    // of letting either of those play out.
    if (values['record-verdict'] === '-') {
      opError(
        "--record-verdict - can't be combined with reading the request from stdin (both would read the same stream). " +
          'Pass the request via --request/--file, or write the verdict to a file and use --record-verdict <file> instead.'
      );
    }
    request = (await readStdin()).trim();
  }
}

if (!request) {
  // Print usage to stderr and exit 1
  process.stderr.write(USAGE + '\n');
  process.exit(1);
}

if (values['prompt-only']) {
  const specFanPrompt = buildSpecReaderPrompt(request);
  const placeholderSpecReadings = Array.from({ length: n }, (_, i) => ({
    spec: `<reading ${i + 1} spec>`,
    assumptions: [`<assumption ${i + 1}>`],
    decisions: [{ point: `<point ${i + 1}>`, choice: `<choice ${i + 1}>` }],
  }));
  const divergencePrompt = buildDivergencePrompt(placeholderSpecReadings);

  if (values['record-verdict'] !== undefined) {
    await recordPromptOnlyVerdict([specFanPrompt, divergencePrompt], { mode: 'spec', request });
  }

  promptOnly([specFanPrompt, divergencePrompt]);
}

let result;
try {
  result = await runSpecMode(request, {
    n,
    tier: tierOverride ?? 'cheap',
    allowPartialFan: values['allow-partial-fan'],
  });
} catch (err) {
  opError(err.message);
}

const { agreements, divergences, score, errors, requested, used } = result;
const report = renderReport({ agreements, divergences, score, threshold });

if (values['questions-json']) {
  printJson({ ...renderQuestionsJson({ mode: 'spec', divergences, score, threshold }), requested, used, warnings: errors });
} else if (values.json) {
  printJson({
    mode: 'spec',
    agreements,
    divergences,
    score,
    threshold,
    gate: score <= threshold,
    requested,
    used,
    warnings: errors,
  });
} else {
  console.log('# Parallax spec analysis\n');
  console.log(report);
  if (errors.length > 0) console.error('\nwarnings:', errors.join('; '));
}

if (score <= threshold) {
  pass();
} else {
  gateFail(`spec ambiguity score ${score.toFixed(2)} exceeds threshold ${threshold.toFixed(2)}`);
}
