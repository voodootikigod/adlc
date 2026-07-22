#!/usr/bin/env node
// adlc-spend — aggregate recorded gate-manifest token usage into the §6
// unit of account: per-phase spend, the barbell shape, and the §6
// diagnostics. Read-only; never fails the build (there is no "wrong"
// spend shape a gate should block on — this is a report, not a gate).

import { parseArgs, pass, printJson, ADLC_DIR } from '@adlc/core';
import { loadSpend, renderSpendReport } from '../lib/spend.mjs';

const USAGE = 'usage: adlc-spend [--ticket id] [--dir path] [--json]';

const { values: flags } = parseArgs({
  usage: USAGE,
  options: {
    ticket: { type: 'string' },
    dir: { type: 'string', default: ADLC_DIR },
    json: { type: 'boolean', default: false },
  },
});

const { aggregate, skipped } = loadSpend({ ticket: flags.ticket, dir: flags.dir });

if (flags.json) {
  printJson(aggregate);
} else {
  for (const line of renderSpendReport(aggregate)) console.log(line);
  if (skipped.length > 0) {
    console.warn(`warning: ${skipped.length} malformed manifest line(s) skipped`);
  }
}

pass();
