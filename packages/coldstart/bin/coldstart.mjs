#!/usr/bin/env node
// coldstart — P2 ticket executability gate.
// Usage: coldstart <ticket-id> [--tickets path] [--all] [--prompt-only] [--json]

import {
  parseArgs,
  opError,
  printJson,
  promptOnly,
  loadTickets,
  detectProvider,
} from '@adlc/core';

import { buildPrompt, SYSTEM_PROMPT } from '../lib/prompt.mjs';
import { checkAll } from '../lib/gate.mjs';
import { renderReport, buildJsonOutput, allPass } from '../lib/report.mjs';

const { values, positionals } = parseArgs({
  options: {
    tickets: { type: 'string', default: '.adlc/tickets.json' },
    all: { type: 'boolean', default: false },
    'prompt-only': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const promptOnlyMode = values['prompt-only'];
const jsonMode = values['json'];
const ticketsPath = values['tickets'];
const runAll = values['all'];

// ── Load tickets ─────────────────────────────────────────────────────────────

const { tickets, errors } = loadTickets(ticketsPath);

if (errors.length) {
  opError(`ticket file errors:\n  ${errors.join('\n  ')}`);
}

// ── Resolve which ticket(s) to process ───────────────────────────────────────

let targets;

if (runAll) {
  if (tickets.length === 0) {
    opError('no tickets found in ticket file');
  }
  targets = tickets;
} else {
  const ticketId = positionals[0];
  if (!ticketId) {
    opError(
      'usage: coldstart <ticket-id> [--tickets path] [--all] [--prompt-only] [--json]'
    );
  }
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    opError(`unknown ticket id: ${ticketId}`);
  }
  targets = [ticket];
}

// ── --prompt-only: print prompts and exit 0 ──────────────────────────────────

if (promptOnlyMode) {
  const prompts = targets.map(
    (t) => `=== system ===\n${SYSTEM_PROMPT}\n\n=== user (${t.id}) ===\n${buildPrompt(t)}`
  );
  promptOnly(prompts);
  // promptOnly() calls process.exit(0) internally
}

// ── Verify provider is available for real runs ───────────────────────────────

const provider = detectProvider();
if (!provider) {
  opError(
    'no LLM provider configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY\n' +
    '(or use --prompt-only to print the prompts without calling an LLM)'
  );
}

// ── Execute gate ─────────────────────────────────────────────────────────────

let results;
try {
  results = await checkAll(targets);
} catch (err) {
  opError(`LLM call failed: ${err.message}`);
}

// ── Output ───────────────────────────────────────────────────────────────────

if (jsonMode) {
  printJson(buildJsonOutput(results));
} else {
  console.log(renderReport(results));
}

// ── Exit ─────────────────────────────────────────────────────────────────────

if (allPass(results)) {
  process.exit(0);
} else {
  process.exit(2);
}
