#!/usr/bin/env node
// behavior-diff — ADLC C14 behavior-space diff for the P6 human gate.
// Verbs: capture | compare

import { readFileSync } from 'node:fs';
import { parseArgs, pass, gateFail, opError, printJson } from '../../core/index.mjs';
import { validateConfig, runCapture, writeSnapshot } from '../lib/capture.mjs';
import { loadSnapshot, compareSnapshots } from '../lib/compare.mjs';
import { renderReport } from '../lib/report.mjs';

const { values: flags, positionals } = parseArgs({
  options: {
    config: { type: 'string' },
    out:    { type: 'string' },
    json:   { type: 'boolean', default: false },
  },
});

const verb = positionals[0];

if (!verb) {
  opError(
    'usage: behavior-diff <verb> [options]\n' +
    'verbs:\n' +
    '  capture --config behavior.json --out before.json\n' +
    '  compare before.json after.json [--json]'
  );
}

// ── capture ──────────────────────────────────────────────────────────────────
if (verb === 'capture') {
  if (!flags.config) {
    opError('capture requires --config <behavior.json>');
  }
  if (!flags.out) {
    opError('capture requires --out <output.json>');
  }

  let config;
  try {
    const raw = readFileSync(flags.config, 'utf8');
    config = JSON.parse(raw);
  } catch (err) {
    opError(`cannot read config file "${flags.config}": ${err.message}`);
  }

  const errors = validateConfig(config);
  if (errors.length > 0) {
    opError(`invalid config:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  let snapshot;
  try {
    snapshot = await runCapture(config);
  } catch (err) {
    opError(`capture failed: ${err.message}`);
  }

  try {
    writeSnapshot(snapshot, flags.out);
  } catch (err) {
    opError(`cannot write output file "${flags.out}": ${err.message}`);
  }

  const total = snapshot.routes.length;
  const errored = snapshot.routes.filter((r) => r.error).length;
  const ok = total - errored;

  if (flags.json) {
    printJson({ out: flags.out, total, ok, errored });
  } else {
    console.log(`captured ${ok}/${total} routes (${errored} error${errored !== 1 ? 's' : ''}) → ${flags.out}`);
  }

  pass();
}

// ── compare ───────────────────────────────────────────────────────────────────
if (verb === 'compare') {
  const beforePath = positionals[1];
  const afterPath = positionals[2];

  if (!beforePath || !afterPath) {
    opError('usage: behavior-diff compare before.json after.json [--json]');
  }

  let before, after;
  try {
    before = loadSnapshot(beforePath);
  } catch (err) {
    opError(err.message);
  }
  try {
    after = loadSnapshot(afterPath);
  } catch (err) {
    opError(err.message);
  }

  const result = compareSnapshots(before, after);
  const { identical, changed, onlyInBefore, onlyInAfter } = result;
  const totalChanged = changed.length + onlyInBefore.length + onlyInAfter.length;

  if (flags.json) {
    printJson({ identical: identical.length, changed: totalChanged, result });
  } else {
    console.log(renderReport(result));
  }

  if (totalChanged === 0) {
    pass();
  } else {
    gateFail('');
  }
}

// Unknown verb
opError(`unknown verb: ${verb}. Expected: capture | compare`);
