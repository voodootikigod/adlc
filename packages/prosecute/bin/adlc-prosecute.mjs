#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs, printJson, opError, recordFinding } from '@adlc/core';
import { runProsecution } from '../lib/run.mjs';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    ticket: { type: 'string' },
    target: { type: 'string' },
    revision: { type: 'string' },
    dir: { type: 'string', default: '.adlc' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
    // --record-finding mode: land one CONFIRMED prosecution finding in the
    // findings ledger so P7 lesson-foundry can cluster it (closes the P5→P7 loop).
    'record-finding': { type: 'boolean', default: false },
    file: { type: 'string' },
    desc: { type: 'string' },
    category: { type: 'string' },
    severity: { type: 'string' },
    line: { type: 'string' },
    verdict: { type: 'string' },
  },
});

if (values.help) {
  console.log(`adlc-prosecute --input <passes.json> --ticket id [--target label] [--revision rev] [--dir .adlc] [--json]

ADLC P5 review-evidence recorder.

  --record-finding --file <path> --desc "<prose>" [--category <lens>] [--severity <s>] [--line <n>] [--verdict <v>] [--dir .adlc]
      Record ONE confirmed prosecution finding to <dir>/findings.jsonl for P7
      (lesson-foundry). Call once per surviving finding on a NOT-CLEAR verdict.
      Use plain-prose --desc without quoted/backticked literals so it routes to a
      spec-gap template rather than a lint rule.

Exit codes:
  0  two consecutive dry passes recorded (or a finding recorded)
  1  operational error (e.g. a finding missing --file/--desc — fails closed)
  2  verified findings remain or dry-pass convergence failed
`);
  process.exit(0);
}

// --- record-finding mode (P5 → P7 bridge) ---
if (values['record-finding']) {
  let line;
  if (values.line !== undefined) {
    line = Number(values.line);
    if (!Number.isInteger(line) || line <= 0) opError(`--line must be a positive integer, got "${values.line}"`);
  }
  let entry;
  try {
    entry = recordFinding(
      {
        file: values.file,
        desc: values.desc,
        category: values.category,
        severity: values.severity,
        line,
        verdict: values.verdict,
      },
      values.dir
    );
  } catch (err) {
    opError(err.message); // fail closed: a malformed finding is exit 1, never a silent no-op
  }
  if (values.json) {
    printJson(entry);
  } else {
    console.log(`recorded finding → ${values.dir}/findings.jsonl (${entry.category}, ${entry.file})`);
  }
  process.exit(0);
}

if (!values.input) opError('usage: adlc-prosecute --input <passes.json> --ticket id');
if (!values.ticket) opError('usage: adlc-prosecute --input <passes.json> --ticket id');

let input;
try {
  input = JSON.parse(readFileSync(values.input, 'utf8'));
} catch (err) {
  opError(`could not read input: ${err.message}`);
}

const result = runProsecution(input, {
  ticket: values.ticket,
  target: values.target,
  revision: values.revision,
  inputPath: values.input,
  dir: values.dir,
});

if (values.json) {
  printJson(result);
} else if (result.exitCode === 0) {
  console.log(result.message);
} else {
  console.error(result.message);
  if (result.errors) console.error(result.errors.join('\n'));
}

process.exit(result.exitCode);
