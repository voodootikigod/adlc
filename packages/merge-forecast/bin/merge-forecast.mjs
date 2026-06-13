#!/usr/bin/env node
/**
 * merge-forecast — Conflict forecast + dispatch schedule (ADLC D2).
 *
 * Usage: merge-forecast [--tickets path] [--width N]
 *                       [--build-min X --merge-min Y]
 *                       [--co-change-limit N] [--conflict-threshold F]
 *                       [--json]
 *
 * Exit codes:
 *   0  gate passes
 *   1  operational error (bad tickets file, not a git repo for co-change)
 *   2  gate fails (--width > certifiedWidth, or vetoed pair concurrent)
 */

import { parseArgs, loadTickets, pass, opError, printJson } from '@adlc/core';
import { runForecast } from '../lib/forecast.mjs';
import { formatForecast } from '../lib/output.mjs';

const { values } = parseArgs({
  options: {
    tickets: { type: 'string', default: '.adlc/tickets.json' },
    width: { type: 'string' },
    'build-min': { type: 'string' },
    'merge-min': { type: 'string' },
    'co-change-limit': { type: 'string' },
    'conflict-threshold': { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`merge-forecast — Conflict forecast + dispatch schedule (ADLC D2)

Usage:
  merge-forecast [options]

Options:
  --tickets <path>           Path to tickets JSON (default: .adlc/tickets.json)
  --width <N>                Desired fan-out width; exit 2 if > certifiedWidth
  --build-min <X>            Mean ticket build time in minutes (for backpressure)
  --merge-min <Y>            Mean merge-rebase-regreen time in minutes
  --co-change-limit <N>      Git log depth for co-change mining (default: 500)
  --conflict-threshold <F>   Score >= this triggers SEQUENCE verdict (default: 0.5)
  --json                     Machine-readable JSON output
  --help                     Show this help

Exit codes:
  0  Gate passes
  1  Operational error (bad tickets file, etc.)
  2  Gate fails (--width > certifiedWidth, vetoed pair concurrent)
`);
  process.exit(0);
}

// Parse numeric flags
function parseNum(val, name, defaultVal, integer = false) {
  if (val === undefined || val === null) return defaultVal;
  const n = integer ? parseInt(val, 10) : parseFloat(val);
  if (isNaN(n)) opError(`--${name} must be a number, got: ${val}`);
  return n;
}

const ticketsPath = values.tickets;
const widthFlag = values.width !== undefined ? parseNum(values.width, 'width', null, true) : null;
const buildMin = values['build-min'] !== undefined ? parseNum(values['build-min'], 'build-min', null) : null;
const mergeMin = values['merge-min'] !== undefined ? parseNum(values['merge-min'], 'merge-min', null) : null;
const coChangeLimit = parseNum(values['co-change-limit'], 'co-change-limit', 500, true);
const conflictThreshold = parseNum(values['conflict-threshold'], 'conflict-threshold', 0.5);

// Load tickets
const { tickets, errors: ticketErrors } = loadTickets(ticketsPath);
if (ticketErrors.length > 0) {
  opError(`ticket errors:\n  ${ticketErrors.join('\n  ')}`);
}
if (tickets.length === 0) {
  opError('no tickets found');
}

// Run forecast
let result;
try {
  result = await runForecast({
    tickets,
    root: process.cwd(),
    coChangeLimit,
    conflictThreshold,
    width: widthFlag,
    buildMin,
    mergeMin,
  });
} catch (err) {
  opError(err.message ?? String(err));
}

// Output
if (values.json) {
  printJson(result);
} else {
  process.stdout.write(formatForecast(result));
}

// Exit based on gate failures
if (result.gateFailures.length > 0) {
  const msg = 'Gate failed:\n' + result.gateFailures.map((f) => `  ${f}`).join('\n');
  // Already printed; just exit 2
  if (!values.json) console.error('\n' + msg);
  process.exit(2);
}

pass();
