#!/usr/bin/env node
/**
 * consensus-fix — N-version fix for a failing test (ADLC C7).
 *
 * Usage:
 *   consensus-fix --test-cmd "npm test" --files src/foo.mjs,src/bar.mjs
 *                 [--n 3] [--tier mid] [--apply] [--allow-dirty]
 *                 [--json] [--prompt-only]
 */

import { writeFileSync } from 'node:fs';
import {
  parseArgs,
  pass,
  gateFail,
  opError,
  printJson,
  promptOnly,
  isDirty,
  complete,
  resolveModel,
  detectProvider,
} from '../../core/index.mjs';
import { runConsensusFix } from '../lib/runner.mjs';
import { buildPrompt } from '../lib/prompt.mjs';
import { takeSnapshot, restoreSnapshot } from '../lib/snapshot.mjs';
import { formatReport, formatJson } from '../lib/format.mjs';

const { values } = parseArgs({
  options: {
    'test-cmd': { type: 'string' },
    files: { type: 'string' },
    n: { type: 'string', default: '3' },
    tier: { type: 'string', default: 'mid' },
    apply: { type: 'boolean', default: false },
    'allow-dirty': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    'prompt-only': { type: 'boolean', default: false },
  },
});

// Validate required args.
if (!values['test-cmd']) opError('--test-cmd is required');
if (!values['files']) opError('--files is required');

const testCmd = values['test-cmd'];
const filePaths = values['files'].split(',').map((f) => f.trim()).filter(Boolean);
if (filePaths.length === 0) opError('--files must list at least one file path');

const n = parseInt(values['n'], 10);
if (isNaN(n) || n < 1) opError(`--n must be a positive integer, got: ${values['n']}`);

const tier = values['tier'];
if (!['cheap', 'mid', 'frontier'].includes(tier)) {
  opError(`--tier must be cheap|mid|frontier, got: ${tier}`);
}

// --prompt-only: build and print prompts without running LLM.
if (values['prompt-only']) {
  let snapshot;
  try {
    snapshot = takeSnapshot(filePaths);
  } catch (err) {
    opError(`could not read files for --prompt-only: ${err.message}`);
  }
  // We don't have test output yet in prompt-only mode — use placeholder.
  const prompt = buildPrompt({
    testCmd,
    testOutput: '<test output will appear here>',
    snapshot,
  });
  promptOnly(Array.from({ length: n }, () => prompt));
  // promptOnly exits 0
}

// Safety: refuse dirty tree unless --allow-dirty.
if (!values['allow-dirty']) {
  let dirty = false;
  try {
    dirty = isDirty();
  } catch {
    // Not a git repo or git not available — skip the check.
  }
  if (dirty) {
    opError('working tree has uncommitted changes — commit or stash first, or use --allow-dirty');
  }
}

// Build completeFn using core, with provider/model resolution.
const provider = detectProvider();
if (!provider) {
  opError(
    'no LLM provider configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY (or use --prompt-only)'
  );
}
// modelId resolved for reference (complete() handles resolution internally).
resolveModel(provider, { tier });

async function completeFn(prompt) {
  return complete({ tier, prompt });
}

// SIGINT handler — restore files from snapshot on interrupt.
// outerSnapshot is populated just before runConsensusFix starts.
let outerSnapshot = null;
process.on('SIGINT', () => {
  if (outerSnapshot) {
    try {
      restoreSnapshot(outerSnapshot);
    } catch {
      // Best effort.
    }
  }
  process.exit(1);
});

// Take snapshot early so SIGINT can restore if interrupted during fan.
try {
  outerSnapshot = takeSnapshot(filePaths);
} catch (err) {
  opError(`could not read --files: ${err.message}`);
}

let result;
try {
  result = await runConsensusFix({
    testCmd,
    files: filePaths,
    n,
    tier,
    completeFn,
    onProgress: (msg) => {
      if (!values['json']) console.log(msg);
    },
  });
} catch (err) {
  if (err.isOpError) opError(err.message);
  opError(`unexpected error: ${err.message}`);
}

const {
  survivors,
  discarded,
  failed,
  groups,
  allDivergent,
  selectionResult,
} = result;

// --apply: write winner changes if present, but only when not all-divergent.
// If allDivergent=true the spec mandates we refuse to apply and escalate;
// writing any change before exit 2 would silently mutate the source files.
let applied = false;
if (values['apply'] && selectionResult && !allDivergent) {
  const { winner } = selectionResult;
  for (const { file, content } of winner.changes) {
    writeFileSync(file, content, 'utf8');
  }
  applied = true;
}

// Output.
if (values['json']) {
  printJson(formatJson({
    survivors,
    discarded,
    failed,
    groups,
    allDivergent,
    selectionResult,
    applied,
  }));
} else {
  console.log(
    formatReport({
      survivors,
      discarded,
      failed,
      groups,
      allDivergent,
      selectionResult,
      applied,
      dryRun: !values['apply'],
    })
  );
}

// Exit codes.
if (survivors.length === 0) {
  gateFail('no candidates survived — gate fails');
}
if (allDivergent) {
  gateFail('all-divergent: spec ambiguity — escalate');
}
pass();
