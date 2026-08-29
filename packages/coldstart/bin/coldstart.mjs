#!/usr/bin/env node
// coldstart — P2 ticket executability gate.
// Usage: coldstart <ticket-id> [--tickets path] [--all] [--tier cheap|mid|frontier] [--prompt-only] [--json]

import {
  parseArgs,
  opError,
  printJson,
  promptOnly,
  loadTickets,
  detectProvider,
} from '@adlc/core';

import { buildPrompt, SYSTEM_PROMPT } from '../lib/prompt.mjs';
import { checkAll, resolveExpectedModel } from '../lib/gate.mjs';
import { buildRecordPlan } from '../lib/cache.mjs';
import { renderReport, buildJsonOutput, allPass } from '../lib/report.mjs';
import { activeTickets } from '../lib/active-tickets.mjs';
import { USAGE, OPTIONS, parseMaxAgeDays } from '../lib/cli-options.mjs';
import { getKey } from '@adlc/gate-manifest/lib/sign.mjs';

// lib/verdict.mjs (and the @adlc/gate-manifest package it pulls in) is
// imported lazily, only when --record-verdict is actually used — see below —
// so plain --prompt-only runs never pay for or depend on it. The real
// (non-prompt-only) path below also imports gate-manifest lazily, for the
// same reason: only pay for it on the path that has something to record.

const { values, positionals } = parseArgs({ usage: USAGE, options: OPTIONS });

const VALID_TIERS = ['cheap', 'mid', 'frontier'];
if (!VALID_TIERS.includes(values.tier)) {
  opError(`--tier must be cheap|mid|frontier, got: ${values.tier}`);
}

if (values['record-verdict'] !== undefined && !values['prompt-only']) {
  opError('--record-verdict requires --prompt-only');
}

const maxAgeResult = parseMaxAgeDays(values['max-age']);
if (!maxAgeResult.ok) {
  opError(maxAgeResult.error);
}
const maxAgeMs = maxAgeResult.maxAgeMs;

const promptOnlyMode = values['prompt-only'];
const jsonMode = values['json'];
const ticketsPath = values['tickets'];
const runAll = values['all'];
const tier = values['tier'];
const force = values['force'];

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
  // --all audits open backlog only: skip completed (tombstoned) tickets. A
  // completed ticket can still be coldstarted explicitly by id (below).
  targets = activeTickets(tickets);
  if (targets.length === 0) {
    opError('no active tickets found (all tickets are completed)');
  }
} else {
  const ticketId = positionals[0];
  if (!ticketId) {
    opError(USAGE);
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

  if (values['record-verdict'] !== undefined) {
    // Print the prompt(s) — same evidence surface as plain --prompt-only —
    // then capture the operator's answer into the gate-manifest ledger so
    // the audit trail shows the gate was answered *and* what it concluded.
    for (const [i, p] of prompts.entries()) {
      if (prompts.length > 1) console.log(`--- prompt ${i + 1} of ${prompts.length} ---`);
      console.log(p);
    }

    const { readVerdictSource, recordVerdict } = await import('../lib/verdict.mjs');
    const verdict = await readVerdictSource(values['record-verdict']);
    const ticket = runAll ? undefined : targets[0].id;
    const entry = recordVerdict({
      ticket,
      verdict,
      key: getKey(),
      extra: { ticketIds: targets.map((t) => t.id), tier },
    });
    console.log(`gate-manifest: recorded seq=${entry.seq} gate=${entry.gate}${ticket ? ` ticket=${ticket}` : ''}`);
    process.exit(0);
  }

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
// Content-addressed caching (issue #278): a ticket whose hash matches a
// prior gate-manifest entry for the SAME resolved model, recorded within
// --max-age days, is served from that entry — no LLM call. --force bypasses.

let results;
try {
  results = await checkAll(targets, tier, { force, maxAgeMs, dir: undefined });
} catch (err) {
  // Covers provider/network failures AND an unreadable verdict (issue #594 —
  // `coldstart: unreadable executability verdict — …`): both mean the audit
  // did not produce a verdict, so neither may read as a pass.
  opError(`could not obtain an executability verdict: ${err.message}`);
}

// ── Record usage + cache evidence (issues #272, #278) ───────────────────────
// One gate-manifest entry PER TICKET actually audited — a cache HIT reuses
// prior evidence rather than manufacturing a duplicate entry for the same
// verification, and a cache hit is what makes a later run's lookup possible
// in the first place, so recording must be per-ticket, not aggregated across
// the whole --all run the way the pre-#278 design did. buildRecordPlan
// returns [] when there's nothing to record (every result cached/mocked);
// looping over that is already a no-op, so there is no separate "is there
// anything to record?" branch here to leave untested.

const { record } = await import('@adlc/gate-manifest/lib/record.mjs');
const recordPlan = buildRecordPlan(results, targets, { model: resolveExpectedModel(tier), tier });
for (const entry of recordPlan) record({ ...entry, key: getKey() });

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
