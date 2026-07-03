#!/usr/bin/env node
// ticket-prune — reports (and, with --write, archives) stale tickets out of
// .adlc/tickets.json. Dry-run by default, consistent with every other ADLC
// writer (skill-rot, rejection-mining, model-ratchet). Archives to a
// gitignored .adlc/tickets.archive.json rather than deleting outright.
//
// Usage: ticket-prune [--tickets path] [--archive path] [--base-ref ref] [--write] [--json]
//
// This is advisory (like model-ratchet), not a pass/fail gate: stale tickets
// are clutter, not a merge blocker. Exit codes: 0 = report/write succeeded
// (regardless of how many stale tickets were found), 1 = operational error.

import { parseArgs, opError, printJson } from '@adlc/core';
import { runTicketPrune } from '../lib/run.mjs';
import { renderReport, toJson } from '../lib/format.mjs';

const USAGE =
  'usage: ticket-prune [--tickets path] [--archive path] [--base-ref ref] [--write] [--json]';

const { values } = parseArgs({
  usage: USAGE,
  options: {
    tickets: { type: 'string', default: '.adlc/tickets.json' },
    archive: { type: 'string', default: '.adlc/tickets.archive.json' },
    'base-ref': { type: 'string', default: 'HEAD' },
    write: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const result = runTicketPrune({
  cwd: process.cwd(),
  ticketsPath: values.tickets,
  archivePath: values.archive,
  baseRef: values['base-ref'],
  write: values.write,
});

if (!result.ok) {
  opError(result.error);
}

if (values.json) {
  printJson(toJson(result));
} else {
  console.log(renderReport(result));
}

process.exit(0);
