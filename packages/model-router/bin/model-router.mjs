#!/usr/bin/env node
/**
 * model-router — Deterministic per-ticket model assignment (ADLC D1).
 *
 * Usage: model-router [--tickets <path>] [--floor <number>] [--json]
 */

import { parseArgs, pass, gateFail, opError, printJson } from '../../core/index.mjs';
import { runRouter } from '../lib/router.mjs';
import { formatTable } from '../lib/format.mjs';

const { values } = parseArgs({
  options: {
    tickets: { type: 'string' },
    floor: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

const floor = values.floor !== undefined ? parseFloat(values.floor) : 0.2;
if (isNaN(floor) || floor < 0 || floor > 1) {
  opError(`--floor must be a number between 0 and 1, got: ${values.floor}`);
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
