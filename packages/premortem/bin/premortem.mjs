#!/usr/bin/env node
// bin/premortem.mjs — thin CLI wrapper for the premortem tool.

import { parseArgs, opError } from '../../core/index.mjs';
import { run } from '../lib/run.mjs';

const { values, positionals } = parseArgs({
  options: {
    tier:         { type: 'string',  default: 'frontier' },
    out:          { type: 'string' },
    json:         { type: 'boolean', default: false },
    'prompt-only':{ type: 'boolean', default: false },
    help:         { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`premortem <spec.md> [--tier cheap|mid|frontier] [--out report.md] [--json] [--prompt-only]

Failure-first spec stress test (AIDLC C2).

  <spec.md>        Path to the spec file to analyse (required)
  --tier           Model tier: cheap | mid | frontier  (default: frontier)
  --out            Write markdown report to this file instead of stdout
  --json           Emit machine-readable JSON {causes:[...]}
  --prompt-only    Print the exact prompt and exit 0 (no API key needed)
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

await run({
  specPath,
  tier: values.tier,
  outPath: values.out,
  json: values.json,
  promptOnlyMode: values['prompt-only'],
});
