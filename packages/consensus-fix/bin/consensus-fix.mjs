#!/usr/bin/env node
/**
 * consensus-fix — N-version fix for a failing test (ADLC C7).
 *
 * Usage:
 *   consensus-fix --test-cmd "npm test" --files src/foo.mjs,src/bar.mjs
 *                 [--rails "npm test"] [--n 3] [--tier mid] [--apply]
 *                 [--provider <name> | --providers <a,b,c>]
 *                 [--allow-dirty] [--json] [--prompt-only]
 *
 *   --test-cmd is the repro gate (the specific failing test).
 *   --rails    is the regression gate (the FULL frozen rail suite). A candidate
 *              survives only if BOTH gates pass. Without --rails, candidates are
 *              not checked against the rails and a WARNING is printed.
 *   --provider forces a single provider for the whole run (anthropic|openai|
 *              gemini|agy), overriding ADLC_PROVIDER for this invocation only.
 *              Default (no flag): single-provider auto-detect, unchanged.
 *   --providers <a,b,c> draws ONE candidate fix per named provider family
 *              instead of --n resamples of one auto-detected provider —
 *              cross-family diversity per ADR-0007. Overrides --n (the fan
 *              width becomes the number of providers named). Mutually
 *              exclusive with --provider.
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
  PROVIDER_NAMES,
} from '@adlc/core';
import { runConsensusFix } from '../lib/runner.mjs';
import { buildPrompt } from '../lib/prompt.mjs';
import { takeSnapshot, restoreSnapshot } from '../lib/snapshot.mjs';
import { formatReport, formatJson } from '../lib/format.mjs';

const { values } = parseArgs({
  options: {
    'test-cmd': { type: 'string' },
    rails: { type: 'string' },
    files: { type: 'string' },
    n: { type: 'string', default: '3' },
    tier: { type: 'string', default: 'mid' },
    provider: { type: 'string' },
    providers: { type: 'string' },
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
const railsCmd = values['rails'] || undefined;
const filePaths = values['files'].split(',').map((f) => f.trim()).filter(Boolean);
if (filePaths.length === 0) opError('--files must list at least one file path');

const n = parseInt(values['n'], 10);
if (isNaN(n) || n < 1) opError(`--n must be a positive integer, got: ${values['n']}`);

const tier = values['tier'];
if (!['cheap', 'mid', 'frontier'].includes(tier)) {
  opError(`--tier must be cheap|mid|frontier, got: ${tier}`);
}

// --provider / --providers: per-invocation provider selection (issue #63).
// Additive only — omit both and behavior is unchanged (single auto-detected
// provider, --n resamples).
const providerOverride = values['provider'] || undefined;
const providersRaw = values['providers'] || undefined;

if (providerOverride && providersRaw) {
  opError('--provider and --providers are mutually exclusive — use one or the other');
}
if (providerOverride && !PROVIDER_NAMES.includes(providerOverride)) {
  opError(`--provider must be one of: ${PROVIDER_NAMES.join(', ')}, got: ${providerOverride}`);
}

let providerNames;
if (providersRaw) {
  providerNames = providersRaw.split(',').map((p) => p.trim()).filter(Boolean);
  if (providerNames.length === 0) opError('--providers must list at least one provider name');
  const unknown = providerNames.filter((p) => !PROVIDER_NAMES.includes(p));
  if (unknown.length > 0) {
    opError(`--providers has unknown provider name(s): ${unknown.join(', ')} (known: ${PROVIDER_NAMES.join(', ')})`);
  }
  const dupes = [...new Set(providerNames.filter((p, i) => providerNames.indexOf(p) !== i))];
  if (dupes.length > 0) {
    opError(`--providers must name DISTINCT providers — duplicate(s): ${dupes.join(', ')}`);
  }
}

// Fan width: one candidate per named provider when --providers is supplied,
// otherwise the usual --n resamples of the single auto-detected provider.
const fanWidth = providerNames ? providerNames.length : n;

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
  promptOnly(Array.from({ length: fanWidth }, () => prompt));
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
if (providerNames) {
  // --providers: confirm EACH named provider is actually available up front,
  // so a missing API key surfaces as a clean opError instead of an N-deep
  // "LLM call failed" discard buried in the report.
  const missing = providerNames.filter((name) => !detectProvider(process.env, name));
  if (missing.length > 0) {
    opError(
      `--providers requested provider(s) not available (missing API key): ${missing.join(', ')}\n` +
        'Set the corresponding API key env var for each requested provider, or use --prompt-only.'
    );
  }
} else {
  const provider = detectProvider(process.env, providerOverride);
  if (!provider) {
    opError(
      providerOverride
        ? `--provider ${providerOverride} is not available — set its API key (or ADLC_AGY for agy)`
        : 'no LLM provider configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY (or use --prompt-only)'
    );
  }
  // modelId resolved for reference (complete() handles resolution internally).
  resolveModel(provider, { tier });
}

// `providerName` is only passed by runConsensusFix when --providers is set
// (one call per named provider); otherwise it's undefined and `provider:
// providerOverride` falls back to --provider (or plain auto-detect if unset).
async function completeFn(prompt, providerName) {
  return complete({ tier, prompt, provider: providerName ?? providerOverride });
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
    railsCmd,
    files: filePaths,
    n,
    tier,
    providerNames,
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
  railsChecked,
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
    railsChecked,
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
      railsChecked,
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
