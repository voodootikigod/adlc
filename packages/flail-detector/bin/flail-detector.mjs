#!/usr/bin/env node
// flail-detector — ADLC C6 session-log flail analysis (mechanical two-strike rule).
// Thin CLI: parse args, call lib, exit with the correct code.

import { readFileSync, existsSync } from 'node:fs';
import { parseArgs, opError, printJson } from '../../core/index.mjs';
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
    json:         { type: 'boolean', default: false },
    help:         { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`flail-detector <log-file> [--scope <glob>...] [--max-repeat <n>] [--max-bytes <n>] [--json]

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
  --json            Machine-readable JSON output.
  --help            Show this help.

Signals detected:
  repeated-error  Error/exception lines whose normalized signature repeats >= --max-repeat
  scope-violation File paths in tool-log lines that fall outside --scope (only when given)
  edit-churn      Same file path appearing in >= 3 write/edit lines
  size            Log file byte count > --max-bytes (only when --max-bytes given)

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
const result = analyze({ lines, bytes, scopes, maxRepeat, maxBytes });

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (values.json) {
  printJson(result);
} else {
  console.log(formatResult(result));
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

process.exit(result.verdict === 'flail' ? 2 : 0);
