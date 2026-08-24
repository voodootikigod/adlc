#!/usr/bin/env node
// ticket-prune — reports (and, with --write, tombstones) stale tickets in
// .adlc/tickets.json. Dry-run by default, consistent with every other ADLC
// writer (skill-rot, rejection-mining, model-ratchet). A stale ticket is
// tombstoned by adding `completed: true` in place (never removed) — the exact
// annotation the rails-guard CI gate accepts for a rails-less ticket, so the
// pruned tickets.json merges through an ordinary PR. Stale tickets that still
// freeze rails (or already carry a `completed` field) are only REPORTED, under
// needsCeremony — complete them individually with the canonical command below.
//
// Usage: ticket-prune [--tickets path] [--base-ref ref] [--write] [--json]
//
// This is advisory (like model-ratchet), not a pass/fail gate: stale tickets
// are clutter, not a merge blocker. Exit codes: 0 = report/write succeeded
// (regardless of how many stale tickets were found), 1 = operational error
// (including the deprecated --ceremony, see below).
//
// --ceremony is DEPRECATED (#208). It was a bulk, evidence-less, legacy-store-only
// completion of rail-freezing tickets; invoking it now fails closed and redirects
// to the canonical per-ticket path:
//   adlc ticket complete <id> --write --authorize --json
// (per-ticket — no TOCTOU, records manifest evidence, works on both backends).
// The flag is still accepted only so the redirect fires instead of "unknown flag".

import { parseArgs, opError, printJson } from '@adlc/core';
import { runTicketPrune } from '../lib/run.mjs';
import { renderReport, toJson } from '../lib/format.mjs';
import { resolveKeyFromEnv } from '@adlc/tickets/lib/key-contract.mjs';

const USAGE = 'usage: ticket-prune [--tickets path] [--base-ref ref] [--write] [--allow-unsigned] [--ceremony] [--json]';

const { values } = parseArgs({
  usage: USAGE,
  options: {
    tickets: { type: 'string', default: '.adlc/tickets.json' },
    'base-ref': { type: 'string', default: 'HEAD' },
    write: { type: 'boolean', default: false },
    ceremony: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    // A --write against a frozen trust root must be signable; this records the
    // audit unsigned on purpose. Same contract as `adlc ticket --allow-unsigned`.
    'allow-unsigned': { type: 'boolean', default: false },
  },
});

const pruneKey = resolveKeyFromEnv();
// Same warning the ticket CLI emits, for the same reason: an unsigned audit entry
// is permanent and proves nothing about who made the change, so the operator hears
// about it before the write rather than discovering it in the manifest later.
if (values['allow-unsigned'] && !pruneKey && values.write) {
  console.error(
    'warning: --allow-unsigned with no ADLC_MANIFEST_KEY — if this store is a frozen trust root, the '
    + 'tombstone will be recorded UNSIGNED. An unsigned audit entry is not evidence, and the manifest is '
    + 'append-only, so it is permanent.',
  );
}

const result = runTicketPrune({
  key: pruneKey,
  allowUnsigned: values['allow-unsigned'],
  cwd: process.cwd(),
  ticketsPath: values.tickets,
  baseRef: values['base-ref'],
  write: values.write,
  ceremony: values.ceremony,
});

if (!result.ok) {
  // A directory --write batch that fails mid-way returns what already committed
  // (archived) and which id failed, so the operator can recover instead of
  // guessing. Surface that structured data BEFORE exiting non-zero — dropping it
  // would defeat the partial-batch reporting the writer produces.
  if (values.json && (result.archived?.length || result.failedId)) {
    printJson({ ok: false, error: result.error, archived: result.archived ?? [], failedId: result.failedId ?? null });
  } else if (result.archived?.length) {
    console.error(`partially applied before the failure — archived: ${result.archived.map((a) => a?.id ?? a).join(', ')}` +
      (result.failedId ? `; failed on: ${result.failedId}` : ''));
  }
  opError(result.error);
}

if (values.json) {
  printJson(toJson(result));
} else {
  console.log(renderReport(result));
}

process.exit(0);
