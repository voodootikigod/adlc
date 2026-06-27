#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs, printJson, opError } from '@adlc/core';
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
  },
});

if (values.help) {
  console.log(`adlc-prosecute --input <passes.json> --ticket id [--target label] [--revision rev] [--dir .adlc] [--json]

ADLC P5 review-evidence recorder.

Exit codes:
  0  two consecutive dry passes recorded
  1  operational error
  2  verified findings remain or dry-pass convergence failed
`);
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
