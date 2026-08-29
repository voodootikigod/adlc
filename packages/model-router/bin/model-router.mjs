#!/usr/bin/env node
/**
 * model-router — Deterministic per-ticket model assignment (ADLC D1).
 *
 * Usage: model-router [--tickets <path>] [--floor <number>] [--json]
 */

import { parseArgs, pass, gateFail, opError, printJson } from '@adlc/core';
import { runRouter } from '../lib/router.mjs';
import { formatTable } from '../lib/format.mjs';
import { assertFloor, DEFAULT_FLOOR, FLOOR_RANGE_MESSAGE, parseFloor } from '../lib/floor.mjs';

/**
 * The raw token that followed `--floor` on the command line, or undefined.
 * Read only when parseArgs has already refused the invocation, so the value
 * never reached `values.floor` — e.g. `--floor -0`, which node's parseArgs
 * rejects as ambiguous before any validator runs.
 */
function rawFloorToken(argv) {
  return argv.includes('--floor') ? argv[argv.indexOf('--floor') + 1] : undefined;
}

/**
 * node's parseArgs throws on a dash-leading value after a space (`--floor -0`,
 * `--floor -1`: "argument is ambiguous"), a missing value (`--floor`), and an
 * unknown option. Left uncaught that is a stack trace with exit 1 — an operator
 * could not tell a bad floor from a broken tool, and a floor-shaped failure never
 * reached the range error the flag documents (#697 review). Route every parse
 * failure through opError; a floor-shaped one carries the range message and the
 * raw token, plus the `--floor=<n>` spelling parseArgs accepts for negatives.
 */
function parseFlags(argv) {
  try {
    return parseArgs({
      args: argv,
      options: {
        tickets: { type: 'string' },
        floor: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
    }).values;
  } catch (err) {
    if (!String(err?.code ?? '').startsWith('ERR_PARSE_ARGS')) throw err;
    const reason = String(err.message).split('\n')[0];
    if (/--floor/.test(reason)) {
      const raw = rawFloorToken(argv);
      opError(`${FLOOR_RANGE_MESSAGE}; got: ${raw === undefined ? '(missing)' : raw} (${reason}; write --floor=<n> for a dash-leading value)`);
    }
    opError(reason);
  }
}

const values = parseFlags(process.argv.slice(2));

// (0, 1] only. `--floor 0` used to be accepted and silently disabled the P3
// gate — every ticket set exited 0 and unrailed tickets left frontier (#697).
const floor = values.floor !== undefined ? parseFloor(values.floor) : DEFAULT_FLOOR;
try {
  assertFloor(floor, values.floor);
} catch (err) {
  opError(err.message);
}

let result;
try {
  result = await runRouter({
    ticketsPath: values.tickets,
    floor,
  });
} catch (err) {
  opError(err.message);
}

const { assignments, p3Findings, skippedLedger } = result;

if (values.json) {
  printJson({ assignments, p3Findings });
} else {
  if (assignments.length === 0) {
    console.log('No tickets found.');
  } else {
    console.log(formatTable(assignments));
  }

  if (skippedLedger.length > 0) {
    console.error(`\nWarning: ${skippedLedger.length} malformed ledger line(s) skipped.`);
  }

  if (p3Findings.length > 0) {
    console.error('\nGate findings:');
    for (const f of p3Findings) {
      console.error(`  ${f.message}`);
    }
  }
}

if (p3Findings.length > 0) {
  gateFail(`Gate failed: ${p3Findings.length} ticket(s) not railed enough to build cheaply.`);
}

pass();
