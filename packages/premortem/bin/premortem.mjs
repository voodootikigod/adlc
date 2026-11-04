#!/usr/bin/env node
// bin/premortem.mjs — thin CLI wrapper for the premortem tool.

import { parseArgs, opError } from '@adlc/core';
import { run } from '../lib/run.mjs';
import { getKey } from '@adlc/gate-manifest/lib/sign.mjs';

const { values, positionals } = parseArgs({
  options: {
    tier:         { type: 'string',  default: 'frontier' },
    'max-causes': { type: 'string' },
    out:          { type: 'string' },
    json:         { type: 'boolean', default: false },
    'prompt-only':{ type: 'boolean', default: false },
    'record-verdict': { type: 'string' },
    ticket:       { type: 'string' },
    help:         { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`premortem SPEC.MD [--tier cheap|mid|frontier] [--max-causes N] [--out report.md] [--json] [--prompt-only] [--record-verdict FILE-OR-DASH --ticket ID]

Failure-first spec stress test (ADLC C2).

  <spec.md>        Path to the spec file to analyse (required)
  --tier           Model tier: cheap | mid | frontier  (default: frontier)
  --max-causes <N> Ask for at most <N> causes (positive integer; default: 5 to 10)
  --out            Write markdown report to this file instead of stdout
  --json           Emit machine-readable JSON {causes:[...]}
  --prompt-only    Print the exact prompt and exit 0 (no API key needed)
  --record-verdict <file|->  With --prompt-only: read the operator's answer
                   from <file> (or stdin when '-') and record it into the
                   gate-manifest ledger (.adlc/manifest.jsonl, or .adlc/manifest.d/ in forest mode) via gate-manifest.
                   Requires --ticket — an unbound record can satisfy any ticket's P1 gate.
  --ticket ID      Ticket to bind the recorded verdict to (required with
                   --record-verdict)
  --help           Show this help

Exit codes:
  0  Report produced successfully
  1  Operational error (missing file, no provider, bad model response)
`);
  process.exit(0);
}

const specPath = positionals[0];
if (!specPath) {
  opError('spec file path is required\nUsage: premortem <spec.md> [--tier frontier] [--out report.md] [--json] [--prompt-only]');
}

const VALID_TIERS = ['cheap', 'mid', 'frontier'];
if (!VALID_TIERS.includes(values.tier)) {
  opError(`invalid --tier '${values.tier}' — must be one of: ${VALID_TIERS.join(', ')}`);
}

let maxCauses;
if (values['max-causes'] !== undefined) {
  const rawMax = values['max-causes'].trim();
  const parsedMax = rawMax === '' ? NaN : Number(rawMax);
  if (!Number.isSafeInteger(parsedMax) || parsedMax < 1) {
    opError(`invalid --max-causes '${values['max-causes']}' — must be a positive integer >= 1`);
  }
  maxCauses = parsedMax;
}

if (values['record-verdict'] !== undefined && !values['prompt-only']) {
  opError('--record-verdict requires --prompt-only');
}

await run({
  specPath,
  tier: values.tier,
  maxCauses,
  outPath: values.out,
  json: values.json,
  promptOnlyMode: values['prompt-only'],
  recordVerdictSource: values['record-verdict'],
  ticket: values.ticket,
  key: getKey(),
});
