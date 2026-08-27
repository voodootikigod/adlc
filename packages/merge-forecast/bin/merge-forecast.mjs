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
import { activeTickets } from '../lib/active-tickets.mjs';

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
  // Number() over parseInt/parseFloat: those accept a numeric PREFIX and drop
  // the rest ('1e2' → 1 as an integer, '2.9' → 2, '0.95junk' → 0.95), so a
  // malformed flag silently changed the gate's inputs and still exited 0. The
  // whole token must be one finite number; integer flags must be whole.
  const text = typeof val === 'string' ? val.trim() : '';
  const n = text === '' ? NaN : Number(text);
  if (!Number.isFinite(n)) opError(`--${name} must be a number, got: ${val}`);
  // isSafeInteger, not isInteger: 1e20 is an "integer" JS cannot represent
  // exactly, and its decimal spelling is rejected by git (-n 1e20) — the
  // co-change pass then degrades to a warning and the forecast exits 0
  // without coupling data.
  if (integer && !Number.isSafeInteger(n)) opError(`--${name} must be an integer, got: ${val}`);
  return n;
}

const ticketsPath = values.tickets;
const widthFlag = values.width !== undefined ? parseNum(values.width, 'width', null, true) : null;
const buildMin = values['build-min'] !== undefined ? parseNum(values['build-min'], 'build-min', null) : null;
const mergeMin = values['merge-min'] !== undefined ? parseNum(values['merge-min'], 'merge-min', null) : null;
const coChangeLimit = parseNum(values['co-change-limit'], 'co-change-limit', 500, true);
const conflictThreshold = parseNum(values['conflict-threshold'], 'conflict-threshold', 0.5);

if (conflictThreshold < 0 || conflictThreshold > 1) {
  opError(`--conflict-threshold must be between 0 and 1, got: ${conflictThreshold}`);
}
if (widthFlag !== null && widthFlag < 1) {
  opError(`--width must be >= 1, got: ${widthFlag}`);
}
if (buildMin !== null && buildMin <= 0) {
  opError(`--build-min must be > 0, got: ${buildMin}`);
}
if (mergeMin !== null && mergeMin <= 0) {
  opError(`--merge-min must be > 0, got: ${mergeMin}`);
}
if (coChangeLimit < 1) {
  opError(`--co-change-limit must be >= 1, got: ${coChangeLimit}`);
}

// Load tickets, then drop completed (tombstoned) tickets: finished work must
// not be scheduled or conflict-forecast as open backlog.
const { tickets: allTickets, errors: ticketErrors } = loadTickets(ticketsPath);
if (ticketErrors.length > 0) {
  const cycle = ticketErrors.find((error) => /cycle in ticket DAG/i.test(error));
  if (cycle) {
    const message = `dependency ${cycle} — cannot schedule`;
    const result = {
      pairs: [], waves: [], mergeOrder: [], certifiedWidth: 0,
      backpressureWidth: null, recommendedWidth: 0, warnings: [],
      gateFailures: [message],
      pullQueueNote: 'idle builders claim next unblocked',
    };
    if (values.json) printJson(result);
    else console.error(`merge-forecast: ${message}`);
    process.exit(2);
  }
  opError(`ticket errors:\n  ${ticketErrors.join('\n  ')}`);
}
const tickets = activeTickets(allTickets);
if (tickets.length === 0) {
  opError(allTickets.length > 0 ? 'no active tickets found (all tickets are completed)' : 'no tickets found');
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
