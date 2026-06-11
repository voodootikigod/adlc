#!/usr/bin/env node
// preflight — ADLC D2 Phase 0 environment and permissions check.
// Usage: preflight [--test-cmd "..."] [--gh] [--llm] [--worktrees] [--json]

import { parseArgs, printJson } from '../../core/index.mjs';
import { runChecks } from '../lib/runner.mjs';
import { renderTable, renderVerdict, computeVerdict } from '../lib/render.mjs';

const { values: flags } = parseArgs({
  options: {
    'test-cmd':  { type: 'string' },
    gh:          { type: 'boolean', default: false },
    llm:         { type: 'boolean', default: false },
    worktrees:   { type: 'boolean', default: false },
    json:        { type: 'boolean', default: false },
  },
});

let results;
try {
  results = await runChecks({
    cwd: process.cwd(),
    worktrees: flags.worktrees,
    testCmd: flags['test-cmd'],
    gh: flags.gh,
    llm: flags.llm,
  });
} catch (err) {
  console.error(`error: preflight internal error: ${err.message ?? err}`);
  process.exit(1);
}

const { verdict, failedNames } = computeVerdict(results);

if (flags.json) {
  printJson({ checks: results, verdict, failedNames });
} else {
  const tableLines = renderTable(results);
  for (const line of tableLines) console.log(line);
  console.log('');
  console.log(renderVerdict(verdict, failedNames));
}

process.exit(verdict === 'pass' ? 0 : 2);
