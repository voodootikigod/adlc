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
} from '../../core/index.mjs';
import {
  buildSpecReaderPrompt,
  buildEdgePrompt,
  buildRouteAnswerPrompt,
  buildRouteJudgePrompt,
  buildDivergencePrompt,
} from '../lib/prompts.mjs';
import { renderReport, renderRouteConflict } from '../lib/scoring.mjs';
import { runSpecMode, runEdgeMode, runRouteMode } from '../lib/modes.mjs';

const { values, positionals } = parseArgs({
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
    // COMMON
    n: { type: 'string', default: '3' },
    threshold: { type: 'string', default: '0.25' },
    tier: { type: 'string' },
    json: { type: 'boolean', default: false },
    'prompt-only': { type: 'boolean', default: false },
  },
});

const n = parseInt(values.n, 10);
if (!Number.isInteger(n) || n < 1) opError('--n must be a positive integer');

const threshold = parseFloat(values.threshold);
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  opError('--threshold must be a number between 0 and 1');
}

const tierOverride = values.tier ?? undefined;

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
    promptOnly([edgeFanPrompt, buildDivergencePrompt(placeholderEdgeReadings)]);
  }

  let result;
  try {
    result = await runEdgeMode(ticketA, ticketB, {
      n,
      tier: tierOverride ?? 'cheap',
    });
  } catch (err) {
    opError(err.message);
  }

  const { agreements, divergences, score, errors } = result;
  const report = renderReport({ agreements, divergences, score, threshold });

  if (values.json) {
    printJson({ mode: 'edge', tickets: [idA, idB], agreements, divergences, score, threshold, gate: score <= threshold, warnings: errors });
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
    const answerPrompt = buildRouteAnswerPrompt(question, contextFiles);
    const placeholderAnswers = Array.from({ length: n }, (_, i) => `<answer ${i + 1}>`);
    const judgePrompt = buildRouteJudgePrompt(question, placeholderAnswers);
    promptOnly([answerPrompt, judgePrompt]);
  }

  let result;
  try {
    result = await runRouteMode(question, contextFiles, {
      n,
      tier: tierOverride ?? 'cheap',
    });
  } catch (err) {
    opError(err.message);
  }

  const { equivalent, answer, variants, errors } = result;

  if (values.json) {
    printJson({ mode: 'route', question, equivalent, answer, variants, warnings: errors });
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
    request = (await readStdin()).trim();
  }
}

if (!request) {
  // Print usage to stderr and exit 1
  process.stderr.write(`parallax — measured-ambiguity interrogation (ADLC D3)

Usage:
  parallax --request "feature request text"
  parallax --file req.md
  echo "request" | parallax
  parallax --edge T1 T2 [--tickets path]
  parallax --route "question" [--context file ...]

Flags:
  --n <int>           fan width (default 3)
  --threshold <0-1>   ambiguity gate threshold (default 0.25)
  --tier cheap|mid|frontier  override LLM tier
  --json              machine-readable output
  --prompt-only       print prompts and exit 0 (no API key needed)
  --tickets <path>    tickets file (default .adlc/tickets.json)
  --context <file>    context file(s) for --route mode (repeatable)

Exit codes: 0 = gate passes, 1 = operational error, 2 = gate fails
`);
  process.exit(1);
}

if (values['prompt-only']) {
  const specFanPrompt = buildSpecReaderPrompt(request);
  const placeholderSpecReadings = Array.from({ length: n }, (_, i) => ({
    spec: `<reading ${i + 1} spec>`,
    assumptions: [`<assumption ${i + 1}>`],
    decisions: [{ point: `<point ${i + 1}>`, choice: `<choice ${i + 1}>` }],
  }));
  promptOnly([specFanPrompt, buildDivergencePrompt(placeholderSpecReadings)]);
}

let result;
try {
  result = await runSpecMode(request, {
    n,
    tier: tierOverride ?? 'cheap',
  });
} catch (err) {
  opError(err.message);
}

const { agreements, divergences, score, errors } = result;
const report = renderReport({ agreements, divergences, score, threshold });

if (values.json) {
  printJson({
    mode: 'spec',
    agreements,
    divergences,
    score,
    threshold,
    gate: score <= threshold,
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
