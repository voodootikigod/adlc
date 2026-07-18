#!/usr/bin/env node
// ticket-prune — reports (and, with --write, tombstones) stale tickets in
// .adlc/tickets.json. Dry-run by default, consistent with every other ADLC
// writer (skill-rot, rejection-mining, model-ratchet). A stale ticket is
// tombstoned by adding `completed: true` in place (never removed) — the exact
// annotation the rails-guard CI gate accepts for a rails-less ticket, so the
// pruned tickets.json merges through an ordinary PR. Stale tickets that still
// freeze rails are reported as needing the protected-base admin ceremony (a
// completion there also expires the rails, which the gate reserves for admins).
//
// Usage: ticket-prune [--tickets path] [--base-ref ref] [--write] [--ceremony] [--json]
//
// This is advisory (like model-ratchet), not a pass/fail gate: stale tickets
// are clutter, not a merge blocker. Exit codes: 0 = report/write succeeded
// (regardless of how many stale tickets were found), 1 = operational error
// (including --ceremony without ADLC_RAILS_BYPASS=1).
//
// --ceremony is the protected-base admin action that completes rail-freezing
// shipped tickets (expiring their rails, T36) — the one completion an ordinary
// PR cannot make. It writes nothing unless ADLC_RAILS_BYPASS=1 is set, because
// its output only lands via the protected-base/admin path.

import { parseArgs, opError, printJson } from '@adlc/core';
import { runTicketPrune } from '../lib/run.mjs';
import { renderReport, toJson } from '../lib/format.mjs';

const USAGE = 'usage: ticket-prune [--tickets path] [--base-ref ref] [--write] [--ceremony] [--json]';

const { values } = parseArgs({
  usage: USAGE,
  options: {
    tickets: { type: 'string', default: '.adlc/tickets.json' },
    'base-ref': { type: 'string', default: 'HEAD' },
    write: { type: 'boolean', default: false },
    ceremony: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const result = runTicketPrune({
  cwd: process.cwd(),
  ticketsPath: values.tickets,
  baseRef: values['base-ref'],
  write: values.write,
  ceremony: values.ceremony,
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
