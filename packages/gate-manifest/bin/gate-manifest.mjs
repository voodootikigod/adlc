#!/usr/bin/env node
// gate-manifest — ADLC C11 hash-chained agentic provenance ledger.
// Verbs: record | verify | show | attest

import { parseArgs, pass, gateFail, opError, printJson } from '../../core/index.mjs';
import { record, parseData } from '../lib/record.mjs';
import { verify } from '../lib/verify.mjs';
import { loadFiltered, renderEntries } from '../lib/show.mjs';
import { buildAttest } from '../lib/attest.mjs';
import { AIDLC_DIR } from '../../core/index.mjs';

const { values: flags, positionals } = parseArgs({
  options: {
    ticket: { type: 'string' },
    data:   { type: 'string' },
    files:  { type: 'string' },
    json:   { type: 'boolean', default: false },
    dir:    { type: 'string', default: AIDLC_DIR },
  },
});

const verb = positionals[0];

if (!verb) {
  opError(
    'usage: gate-manifest <verb> [options]\n' +
    'verbs: record <gate-name> [--ticket id] [--data \'{json}\'] [--files a,b,c]\n' +
    '       verify [--json]\n' +
    '       show   [--ticket id] [--json]\n' +
    '       attest [--ticket id]'
  );
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
    console.log(`recorded: seq=${entry.seq} gate=${entry.gate} ts=${entry.ts}`);
  }

  pass();
}

// ── verify ───────────────────────────────────────────────────────────────────
if (verb === 'verify') {
  const result = verify(flags.dir);

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

// Unknown verb
opError(`unknown verb: ${verb}. Expected: record | verify | show | attest`);
