#!/usr/bin/env node
// preflight — ADLC D2 Phase 0 environment and permissions check.
// Usage: preflight [--test-cmd "..."] [--gh] [--llm] [--worktrees] [--json]

import { parseArgs, printJson } from '@adlc/core';
import { runChecks, isBlankTestCmd, EMPTY_TEST_CMD_MESSAGE } from '../lib/runner.mjs';
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

// A --test-cmd that was passed but is empty/whitespace (the `--test-cmd
// "$TEST_CMD"` with an unset variable case, #712) is a USER INPUT error:
// reject it here, before runChecks, so it is reported as such (exit 1, nothing
// on stdout — a --json reader must never see a verdict document for a run
// that refused to start) and not as the generic "internal error" the catch
// below would attach to the library's own guard.
if (isBlankTestCmd(flags['test-cmd'])) {
  console.error(`error: ${EMPTY_TEST_CMD_MESSAGE}`);
  process.exit(1);
}

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
