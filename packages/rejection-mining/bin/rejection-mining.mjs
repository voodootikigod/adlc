#!/usr/bin/env node
// rejection-mining — ADLC C13
// Mine human PR objections into prosecution lenses.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  parseArgs,
  pass,
  opError,
  printJson,
  promptOnly,
} from '@adlc/core';
import { checkGhAvailable, runGh } from '../lib/gh.mjs';
import { fetchSignals, buildClusters } from '../lib/mine.mjs';
import { planLensEmissions } from '../lib/lens.mjs';
import { buildAllPrompts, refineClusters } from '../lib/llm.mjs';
import { buildHumanReport, buildJsonResult } from '../lib/report.mjs';

const { values: flags } = parseArgs({
  options: {
    limit:        { type: 'string',  default: '50' },
    min:          { type: 'string',  default: '2' },
    'out-dir':    { type: 'string',  default: '.adlc/lenses' },
    write:        { type: 'boolean', default: false },
    llm:          { type: 'boolean', default: false },
    tier:         { type: 'string',  default: 'mid' },
    'prompt-only': { type: 'boolean', default: false },
    json:         { type: 'boolean', default: false },
  },
});

const limit  = parseInt(flags.limit, 10);
const minSize = parseInt(flags.min, 10);
const outDir  = flags['out-dir'];
const tier    = flags.tier;

if (isNaN(limit) || limit < 1) {
  opError(`--limit must be a positive integer (got: ${flags.limit})`);
}
if (isNaN(minSize) || minSize < 1) {
  opError(`--min must be a positive integer (got: ${flags.min})`);
}

const VALID_TIERS = ['cheap', 'mid', 'frontier'];
if (!VALID_TIERS.includes(tier)) {
  opError(`--tier must be cheap|mid|frontier, got: ${tier}`);
}

// --prompt-only: print a representative prompt and exit 0. Checked BEFORE any
// gh call — the tool must be usable with zero network access, not just zero
// LLM API keys.
if (flags['prompt-only']) {
  const placeholderCluster = { slug: 'example-cluster', indices: [0] };
  const placeholderSignals = [{ body: '<sample PR rejection comment>', prNumber: 0 }];
  const prompt = buildAllPrompts([placeholderCluster], placeholderSignals)[0];
  promptOnly(prompt);
  // promptOnly exits; unreachable
}

// Verify gh is available
try {
  checkGhAvailable(runGh);
} catch (err) {
  opError(err.message);
}

// Fetch signals from gh
let signals, totalPRs, skippedPRs;
try {
  ({ signals, totalPRs, skippedPRs } = await fetchSignals({ limit, ghRunner: runGh }));
} catch (err) {
  opError(`gh fetch failed: ${err.message}`);
}

if (totalPRs === 0) {
  opError('No PRs found. Check gh auth (run `gh auth login`) and that this is a GitHub-linked repo.');
}

// Cluster signals
const clusters = buildClusters(signals, minSize);

// --llm: refine clusters
let llmRefinements = new Map();
if (flags.llm && clusters.length > 0) {
  try {
    llmRefinements = await refineClusters(clusters, signals, tier);
  } catch (err) {
    opError(`LLM refinement failed: ${err.message}. Use --prompt-only to get prompts.`);
  }
}

// Attach LLM titles back to clusters for reporting
const enrichedClusters = clusters.map((c, idx) => {
  const refinement = llmRefinements.get(idx) ?? null;
  return {
    ...c,
    title: refinement?.title ?? null,
  };
});

// Plan lens emissions
const lensPlans = planLensEmissions(enrichedClusters, signals, outDir, llmRefinements);

// Output
if (flags.json) {
  printJson(buildJsonResult({
    clusters: enrichedClusters,
    lensPlans,
    totalSignals: signals.length,
    totalPRs,
    skippedPRs,
  }));
} else {
  const lines = buildHumanReport({
    clusters: enrichedClusters,
    lensPlans,
    totalSignals: signals.length,
    totalPRs,
    skippedPRs,
  });
  for (const l of lines) console.log(l);
}

// --write: emit lens files
if (flags.write) {
  if (!existsSync(outDir)) {
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (err) {
      opError(`cannot create out-dir "${outDir}": ${err.message}`);
    }
  }

  for (const plan of lensPlans) {
    try {
      writeFileSync(plan.path, plan.content, 'utf8');
      if (!flags.json) console.log(`  wrote: ${plan.path}`);
    } catch (err) {
      opError(`failed to write "${plan.path}": ${err.message}`);
    }
  }
} else if (!flags.json && clusters.length > 0) {
  console.log('  (dry-run — add --write to emit lens files)');
}

if (!flags.json) pass('rejection-mining: done.');
