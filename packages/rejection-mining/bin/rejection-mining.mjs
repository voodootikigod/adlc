#!/usr/bin/env node
// rejection-mining — ADLC C13
// Mine human PR objections into prosecution lenses.

import { existsSync, mkdirSync } from 'node:fs';
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
import { placeLens } from '../lib/lens-write.mjs';
import { buildAllPrompts, refineClusters } from '../lib/llm.mjs';
import { buildHumanReport, buildJsonResult } from '../lib/report.mjs';
import { parsePositiveInt } from '../lib/int-flag.mjs';

const { values: flags } = parseArgs({
  options: {
    limit:        { type: 'string',  default: '50' },
    min:          { type: 'string',  default: '2' },
    'out-dir':    { type: 'string',  default: '.adlc/lenses' },
    write:        { type: 'boolean', default: false },
    force:        { type: 'boolean', default: false },
    llm:          { type: 'boolean', default: false },
    tier:         { type: 'string',  default: 'mid' },
    'prompt-only': { type: 'boolean', default: false },
    json:         { type: 'boolean', default: false },
  },
});

function positiveIntFlag(name) {
  const parsed = parsePositiveInt(flags[name]);
  if (!parsed.ok) opError(`--${name} must be a positive integer (got: ${flags[name]})`);
  return parsed.value;
}

const limit   = positiveIntFlag('limit');
const minSize = positiveIntFlag('min');
const outDir  = flags['out-dir'];
const tier    = flags.tier;

const VALID_TIERS = ['cheap', 'mid', 'frontier'];
if (!VALID_TIERS.includes(tier)) {
  opError(`--tier must be cheap|mid|frontier, got: ${tier}`);
}

// Verify gh is available. This runs before --prompt-only on purpose: the
// prompts are built from REAL mined rejections (issue #743), so a missing gh is
// the operational error it always was, never a placeholder prompt.
try {
  checkGhAvailable(runGh);
} catch (err) {
  opError(err.message);
}

// Fetch signals from gh
let signals, totalPRs, skippedPRs, firstError;
try {
  ({ signals, totalPRs, skippedPRs, firstError } = await fetchSignals({ limit, ghRunner: runGh }));
} catch (err) {
  opError(`gh fetch failed: ${err.message}`);
}

if (totalPRs === 0) {
  opError('No PRs found. Check gh auth (run `gh auth login`) and that this is a GitHub-linked repo.');
}

if (totalPRs > 0 && skippedPRs === totalPRs) {
  const detail = firstError ? ` (cause: ${firstError})` : '';
  opError(`All ${totalPRs} PR(s) failed to fetch details. Check GitHub API rate limits or token permissions.${detail}`);
}

// Cluster signals
const clusters = buildClusters(signals, minSize);

// --prompt-only: print the refinement prompt for every REAL cluster and exit 0
// (issue #743). With nothing to prompt, say so on stderr and print nothing —
// an empty stdout is not a prompt anyone can mistake for a completed gate.
if (flags['prompt-only']) {
  // Partial mining must never read as complete: the normal report shows
  // "PRs skipped"; the prompt-only path says so on stderr before any prompt.
  if (skippedPRs > 0) {
    const cause = firstError ? ` (first error: ${firstError})` : '';
    console.error(`rejection-mining: ${skippedPRs} of ${totalPRs} PR(s) could not be fetched${cause}; the prompts below cover only the ${totalPRs - skippedPRs} that were`);
  }
  if (clusters.length === 0) {
    console.error(`rejection-mining: no clusters at --min ${minSize} over ${totalPRs} PR(s); nothing to prompt`);
    process.exit(0);
  }
  promptOnly(buildAllPrompts(clusters, signals));
  // promptOnly exits; unreachable
}

// --llm: refine clusters
let llmRefinements = new Map();
if (flags.llm && clusters.length > 0) {
  try {
    llmRefinements = await refineClusters(clusters, signals, tier);
  } catch (err) {
    opError(`LLM refinement failed: ${err.message}. Use --prompt-only to get prompts.`);
  }
  if (llmRefinements.size === 0) {
    opError('LLM refinement failed for all clusters. Use --prompt-only to inspect prompts.');
  }
}

// Attach LLM titles back to clusters for reporting
const enrichedClusters = clusters.map((c, idx) => {
  const refinement = llmRefinements.get(idx) ?? null;
  return {
    ...c,
    title: refinement?.title ?? null,
    refined: refinement !== null,
  };
});

// Plan lens emissions
const lensPlans = planLensEmissions(enrichedClusters, signals, outDir, llmRefinements);

// --write: emit lens files BEFORE any report, so the report describes what
// actually landed (issue #746). An existing lens is curated content and is
// skipped unless --force; placement is atomic and no-replace (lib/lens-write.mjs).
// A failed write does not stop the loop or the report: every plan's state is
// emitted, then the run exits 1.
const writeLines = [];
const writeErrors = [];
let reportedPlans = lensPlans;
if (flags.write) {
  if (!existsSync(outDir)) {
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (err) {
      opError(`cannot create out-dir "${outDir}": ${err.message}`);
    }
  }

  reportedPlans = lensPlans.map((plan) => {
    let outcome;
    try {
      outcome = placeLens(plan.path, plan.content, { force: flags.force });
    } catch (err) {
      writeErrors.push(`failed to write "${plan.path}": ${err.message}`);
      return { ...plan, written: false, skipped: null, error: err.message };
    }
    if (outcome === 'skip-exists') {
      writeLines.push(`  skipped (exists): ${plan.path}`);
      return { ...plan, written: false, skipped: 'exists', error: null };
    }
    writeLines.push(`  wrote: ${plan.path}`);
    return { ...plan, written: true, skipped: null, error: null };
  });
}

// Output — after the writes.
if (flags.json) {
  printJson(buildJsonResult({
    clusters: enrichedClusters,
    lensPlans: reportedPlans,
    totalSignals: signals.length,
    totalPRs,
    skippedPRs,
  }));
} else {
  const failedRefinements = flags.llm ? (clusters.length - llmRefinements.size) : 0;
  const lines = buildHumanReport({
    clusters: enrichedClusters,
    lensPlans: reportedPlans,
    totalSignals: signals.length,
    totalPRs,
    skippedPRs,
    failedRefinements,
  });
  for (const l of lines) console.log(l);
  for (const l of writeLines) console.log(l);
  if (!flags.write && clusters.length > 0) {
    console.log('  (dry-run — add --write to emit lens files)');
  }
}

if (writeErrors.length > 0) {
  for (const e of writeErrors) console.error(`rejection-mining: ${e}`);
  process.exit(1);
}

if (!flags.json) pass('rejection-mining: done.');
