#!/usr/bin/env node
// flail-detector — ADLC C6 session-log flail analysis (mechanical two-strike rule).
// Thin CLI: parse args, call lib, exit with the correct code.

import { readFileSync, existsSync } from 'node:fs';
import { parseArgs, opError, printJson, sha256 } from '@adlc/core';
import { appendManifestEntry } from '@adlc/gate-manifest';
import { getKey } from '@adlc/gate-manifest/lib/sign.mjs';
import { parseLog } from '../lib/parse-log.mjs';
import { analyze } from '../lib/analyze.mjs';
import { formatResult } from '../lib/format.mjs';

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  options: {
    scope:      { type: 'string',  multiple: true },
    'max-repeat': { type: 'string',  default: '2' },
    'max-bytes':  { type: 'string' },
    'spent-tokens': { type: 'string' },
    budget:       { type: 'string' },
    record:       { type: 'boolean', default: false },
    ticket:       { type: 'string' },
    json:         { type: 'boolean', default: false },
    help:         { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`flail-detector <log-file> [--scope <glob>...] [--max-repeat <n>] [--max-bytes <n>] [--spent-tokens <n>] [--budget <n>] [--record] [--ticket <id>] [--json]

Session-log flail analysis (ADLC C6) — mechanical two-strike rule.

Arguments:
  <log-file>        Path to the session log file to analyze (required)

Options:
  --scope <glob>    Declared-scope glob pattern (repeatable). When given, file
                    paths in the log that fall outside ALL supplied globs are
                    flagged as scope violations.
  --max-repeat <n>  Trigger repeated-error signal when a normalized error
                    signature appears >= n times (default: 2).
  --max-bytes <n>   Trigger size signal when log exceeds n bytes (default: no limit).
  --spent-tokens <n> Measured token spend for this ticket (e.g. from
                    'adlc spend --ticket <id> --json'). Paired with --budget.
  --budget <n>      The ticket's declared token budget (ticket.budget, or
                    model-router's emitted per-ticket budget). Triggers the
                    budget signal when --spent-tokens exceeds it. Both flags
                    must be given together — with either omitted, the budget
                    signal stays silent rather than guessing (ADLC C6).
  --record          On a clean verdict, append a 'flail-check' manifest entry
                    to .adlc/manifest.jsonl (ADLC P4 evidence).
  --ticket <id>     Ticket to scope the recorded manifest entry to (optional;
                    recorded as null when omitted).
  --json            Machine-readable JSON output.
  --help            Show this help.

Signals detected:
  repeated-error  Error/exception lines whose normalized signature repeats >= --max-repeat
  scope-violation File paths in tool-log lines that fall outside --scope (only when given)
  edit-churn      Same file path appearing in >= 3 write/edit lines
  size            Log file byte count > --max-bytes (only when --max-bytes given)
  budget          --spent-tokens > --budget (only when both given)

Output:
  verdict: 'flail' | 'clean'
  On flail: recommendation block — "Kill the session. Append these dead-ends..."

Exit codes:
  0  clean (gate passes)
  1  operational error (file not found, bad arguments)
  2  flail detected (gate fails)

ADLC phase: C6 / P4 supervisor
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Validate positionals
// ---------------------------------------------------------------------------

const logFile = positionals[0];
if (!logFile) {
  opError('usage: flail-detector <log-file> [options] (use --help for details)');
}

if (!existsSync(logFile)) {
  opError(`log file not found: ${logFile}`);
}

// ---------------------------------------------------------------------------
// Parse options
// ---------------------------------------------------------------------------

const maxRepeat = parseInt(values['max-repeat'], 10);
if (!Number.isInteger(maxRepeat) || maxRepeat < 1) {
  opError('--max-repeat must be a positive integer');
}

let maxBytes = null;
if (values['max-bytes'] !== undefined) {
  maxBytes = parseInt(values['max-bytes'], 10);
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    opError('--max-bytes must be a non-negative integer');
  }
}

const scopes = values.scope ?? [];

const hasSpentTokens = values['spent-tokens'] !== undefined;
const hasBudget = values.budget !== undefined;
if (hasSpentTokens !== hasBudget) {
  opError('--spent-tokens and --budget must be given together (or neither)');
}

let spentTokens = null;
let budget = null;
if (hasSpentTokens) {
  spentTokens = parseInt(values['spent-tokens'], 10);
  if (!Number.isInteger(spentTokens) || spentTokens < 0) {
    opError('--spent-tokens must be a non-negative integer');
  }
  budget = parseInt(values.budget, 10);
  if (!Number.isInteger(budget) || budget < 0) {
    opError('--budget must be a non-negative integer');
  }
}

// ---------------------------------------------------------------------------
// Read and analyze
// ---------------------------------------------------------------------------

let raw;
try {
  raw = readFileSync(logFile, 'utf8');
} catch (err) {
  opError(`could not read log file: ${err.message}`);
}

const { lines, bytes } = parseLog(raw);
const result = analyze({ lines, bytes, scopes, maxRepeat, maxBytes, spentTokens, budget });

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (values.json) {
  printJson(result);
} else {
  console.log(formatResult(result));
}

// ---------------------------------------------------------------------------
// Record on clean verdict
// ---------------------------------------------------------------------------

if (values.record && result.verdict !== 'flail') {
  appendManifestEntry({
    ts: new Date().toISOString(),
    type: 'flail-check',
    ticket: values.ticket ?? null,
    verdict: result.verdict,
    logFile,
    logHash: sha256(raw),
  }, undefined, { key: getKey() });
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

process.exit(result.verdict === 'flail' ? 2 : 0);
