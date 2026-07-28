#!/usr/bin/env node
// gate-manifest — ADLC C11 hash-chained agentic provenance ledger.
// Verbs: record | verify | show | attest

import { parseArgs, pass, gateFail, opError, printJson } from '@adlc/core';
import { record, parseData, ticketCompletionReminder } from '../lib/record.mjs';
import { verify } from '../lib/verify.mjs';
import { loadFiltered, renderEntries } from '../lib/show.mjs';
import { buildAttest } from '../lib/attest.mjs';
import { repairChain } from '../lib/repair.mjs';
import { ADLC_DIR } from '@adlc/core';

const USAGE =
  'usage: gate-manifest <verb> [options]\n' +
  'verbs: record <gate-name> [--ticket id] [--data \'{json}\'] [--files a,b,c]\n' +
  '       verify [--json] [--allow-legacy-unsigned]\n' +
  '       show   [--ticket id] [--json]\n' +
  '       attest [--ticket id]\n' +
  '       repair-chain --reason "..." [--write] [--attest-unsigned] [--json]';

const { values: flags, positionals } = parseArgs({
  usage: USAGE,
  options: {
    ticket: { type: 'string' },
    data:   { type: 'string' },
    files:  { type: 'string' },
    json:   { type: 'boolean', default: false },
    dir:    { type: 'string', default: ADLC_DIR },
    reason: { type: 'string' },
    write:  { type: 'boolean', default: false },
    'attest-unsigned': { type: 'boolean', default: false },
    'allow-legacy-unsigned': { type: 'boolean', default: false },
  },
});

const verb = positionals[0];

if (!verb) {
  opError(USAGE);
}

// ── record ──────────────────────────────────────────────────────────────────
if (verb === 'record') {
  const gate = positionals[1];
  if (!gate) {
    opError('usage: gate-manifest record <gate-name> [--ticket id] [--data \'{json}\'] [--files a,b,c]');
  }

  // Validate --data early so we get opError (exit 1) on bad JSON
  try {
    parseData(flags.data);
  } catch (err) {
    opError(err.message);
  }

  let entry;
  try {
    entry = record({
      gate,
      ticket: flags.ticket,
      rawData: flags.data,
      rawFiles: flags.files,
      dir: flags.dir,
    });
  } catch (err) {
    opError(err.message);
  }

  if (flags.json) {
    printJson(entry);
  } else {
    const signed = typeof entry.sig === 'string' ? ' (signed)' : ' (unsigned)';
    console.log(`recorded: seq=${entry.seq} gate=${entry.gate} ts=${entry.ts}${signed}`);
  }

  // T74: a p6-accept verdict is not ticket completion. Print a one-line reminder
  // of the command that IS — to stderr, so it never corrupts --json stdout, and
  // WITHOUT touching what was recorded (no auto-mutation).
  const reminder = ticketCompletionReminder(gate, flags.ticket);
  if (reminder) console.error(reminder);

  pass();
}

// ── verify ───────────────────────────────────────────────────────────────────
if (verb === 'verify') {
  // --allow-legacy-unsigned: this ledger's own history predates HMAC signing
  // (signing was enabled partway through its life), so a strict verify with a
  // key present would fail forever at the first pre-signing entry. Passing this
  // flag tolerates a missing sig ONLY on that contiguous legacy prefix; a missing
  // sig on any entry after signing was adopted, or a present-but-invalid sig
  // anywhere, still fails the chain. See verify()'s requireSignatures doc.
  const result = verify(flags.dir, { requireSignatures: !flags['allow-legacy-unsigned'] });

  if (flags.json) {
    printJson(result);
  } else {
    console.log(result.message);
  }

  if (result.valid) {
    pass();
  } else {
    gateFail(`gate-manifest verify: ${result.message}`);
  }
}

// ── show ─────────────────────────────────────────────────────────────────────
if (verb === 'show') {
  const { entries, skipped } = loadFiltered({ ticket: flags.ticket, dir: flags.dir });

  if (flags.json) {
    printJson({ entries, skipped });
  } else {
    const lines = renderEntries(entries);
    for (const l of lines) console.log(l);
    if (skipped.length > 0) {
      console.warn(`warning: ${skipped.length} malformed line(s) skipped`);
    }
  }

  pass();
}

// ── attest ───────────────────────────────────────────────────────────────────
if (verb === 'attest') {
  const md = buildAttest({ ticket: flags.ticket, dir: flags.dir });
  console.log(md);
  pass();
}

// ── repair-chain ─────────────────────────────────────────────────────────────
if (verb === 'repair-chain') {
  let result;
  try {
    result = repairChain({
      dir: flags.dir,
      reason: flags.reason,
      write: flags.write,
      attestUnsigned: flags['attest-unsigned'],
    });
  } catch (err) {
    opError(err.message);
  }
  if (flags.json) printJson(result);
  else {
    const attestation = result.newlySignedEntries > 0
      ? `; cryptographically attested ${result.newlySignedEntries} previously unsigned entr${result.newlySignedEntries === 1 ? 'y' : 'ies'}`
      : '';
    console.log(flags.write
      ? `repaired ${result.path}; original preserved at ${result.backup}${attestation}`
      : `repair plan: ${result.originalEntries} entries → ${result.repairedEntries}${attestation}; rerun with --write`);
  }
  pass();
}

// Unknown verb
opError(`unknown verb: ${verb}. Expected: record | verify | show | attest | repair-chain`);
