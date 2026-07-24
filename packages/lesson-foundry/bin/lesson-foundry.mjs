#!/usr/bin/env node
// lesson-foundry — ADLC C9, the compounding closer.
// Converts prosecution findings into permanent defenses.

import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseArgs,
  pass,
  gateFail,
  opError,
  printJson,
  promptOnly,
} from '@adlc/core';
import { loadFindings, buildClusters, findUnbankedClusters } from '../lib/foundry.mjs';
import { planEmissions } from '../lib/emit.mjs';
import { buildHumanReport, buildJsonResult } from '../lib/report.mjs';
import { buildAllPrompts, refineClusters } from '../lib/llm.mjs';

const { values: flags } = parseArgs({
  options: {
    ledger:      { type: 'string',  default: 'findings' },
    min:         { type: 'string',  default: '2' },
    'out-dir':   { type: 'string',  default: '.adlc/lessons' },
    write:       { type: 'boolean', default: false },
    gate:        { type: 'boolean', default: false },
    llm:         { type: 'boolean', default: false },
    tier:        { type: 'string',  default: 'mid' },
    'prompt-only': { type: 'boolean', default: false },
    json:        { type: 'boolean', default: false },
  },
});

const ledgerName = flags.ledger;
const minSize    = parseInt(flags.min, 10);
const outDir     = flags['out-dir'];
const tier       = flags.tier;

if (isNaN(minSize) || minSize < 1) {
  opError(`--min must be a positive integer (got: ${flags.min})`);
}

const VALID_TIERS = ['cheap', 'mid', 'frontier'];
if (!VALID_TIERS.includes(tier)) {
  opError(`--tier must be cheap|mid|frontier, got: ${tier}`);
}

// Resolve ledger directory: look in cwd's .adlc or use the default
// The ledger name may include a path; core's readEntries uses the dir param.
// We pass the ledger name as-is and use the default dir (process.cwd() + '/.adlc').
const ledgerDir = join(process.cwd(), '.adlc');

// Load findings
let findings, skipped, filtered;
try {
  ({ findings, skipped, filtered } = loadFindings(ledgerName, ledgerDir));
} catch (err) {
  opError(`failed to read ledger "${ledgerName}": ${err.message}`);
}

// Build clusters
const clusters = buildClusters(findings, minSize);

// --prompt-only: print LLM prompts and exit 0
if (flags['prompt-only']) {
  if (clusters.length === 0) {
    promptOnly('(no clusters to refine)');
  }
  const prompts = buildAllPrompts(clusters, findings);
  promptOnly(prompts);
  // promptOnly exits; unreachable
}

// --llm: refine cluster wording
let llmRefinements = new Map();
if (flags.llm && clusters.length > 0) {
  try {
    llmRefinements = await refineClusters(clusters, findings, tier);
  } catch (err) {
    opError(`LLM refinement failed: ${err.message}. Use --prompt-only to get prompts.`);
  }
}

// Plan emissions
const plan = planEmissions(clusters, findings, outDir, llmRefinements);

// Gate check: which clusters have no existing defense file? Computed for --write too, so the
// write path emits a spec-gap question for EXACTLY the clusters the gate deems unbanked — the
// two can never disagree (see the template-append filter below).
const unbanked = (flags.gate || flags.write)
  ? findUnbankedClusters(clusters, outDir, existsSync, undefined, undefined, minSize, findings, 0.5)
  : [];

// Output (human or JSON)
if (flags.json) {
  const gateResult = flags.gate
    ? { unbanked: unbanked.map((c) => c.name), pass: unbanked.length === 0 }
    : null;
  printJson(buildJsonResult({ clusters, skipped, filtered, plan, gateResult }));
} else {
  const lines = buildHumanReport({ clusters, skipped, filtered, plan });
  for (const l of lines) console.log(l);
}

// --write: emit files
if (flags.write) {
  // Filter out the synthetic spec-gap-template aggregate entry
  const realPlan = plan.filter((p) => p.cluster !== null);
  const templatePlan = plan.filter((p) => p.route === 'spec-gap-template');

  // Ensure output directory exists
  if (!existsSync(outDir)) {
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (err) {
      opError(`cannot create out-dir "${outDir}": ${err.message}`);
    }
  }

  for (const entry of realPlan) {
    for (const file of entry.files) {
      const fullPath = file.path; // already prefixed with outDir
      try {
        writeFileSync(fullPath, file.content, 'utf8');
        if (!flags.json) console.log(`  wrote: ${fullPath}`);
      } catch (err) {
        opError(`failed to write "${fullPath}": ${err.message}`);
      }
    }
  }

  // Handle interrogation-template.md (append if exists, write if not)
  for (const entry of templatePlan) {
    for (const file of entry.files) {
      const fullPath = file.path;
      try {
        if (file.append && existsSync(fullPath)) {
          // Append only NEW questions, not the header, and never re-append a
          // question already present (dedup so N runs ≠ N copies).
          const existing = readFileSync(fullPath, 'utf8');
          // Append a spec-gap question ONLY for a cluster the gate deems UNBANKED, using the
          // SAME coverage logic as --gate (findUnbankedClusters). This keeps the write path
          // and the gate in lockstep, which no purely text-level dedup could:
          //  - a cluster that merely GREW (round-13) or absorbed an out-of-order earlier
          //    member (round-14) leaves a sub-minSize uncovered remainder → the gate credits
          //    it as banked → its question is NOT re-appended; and
          //  - a FUSED cluster whose uncovered members form their own recurring subcluster
          //    stays unbanked → its question IS (re)emitted, instead of being suppressed for
          //    overlapping the covered part (round-15).
          // findUnbankedClusters read the template BEFORE this run's writes, so a question
          // already present banks its cluster and drops out of the set (idempotent). The line
          // is matched to its cluster by the in-run cluster-id, consistent within one run.
          const unbankedIds = new Set(
            unbanked.filter((c) => c.route === 'spec-gap').map((c) => c.id),
          );
          const lineClusterId = (line) => (line.match(/cluster-id: ([0-9a-f]+)/) || [])[1];
          const newLines = file.content
            .split('\n')
            .filter((l) => l.startsWith('- [ ]'))
            .filter((l) => {
              const id = lineClusterId(l);
              // No id to classify by (never happens for generated lines) → fall back to a
              // literal not-already-present check so a question is never silently dropped.
              return id ? unbankedIds.has(id) : !existing.includes(l.trim());
            });
          if (newLines.length > 0) {
            appendFileSync(fullPath, '\n' + newLines.join('\n') + '\n', 'utf8');
            if (!flags.json) console.log(`  appended: ${fullPath}`);
          } else if (!flags.json) {
            console.log(`  up-to-date: ${fullPath}`);
          }
        } else {
          writeFileSync(fullPath, file.content, 'utf8');
          if (!flags.json) console.log(`  wrote: ${fullPath}`);
        }
      } catch (err) {
        opError(`failed to write "${fullPath}": ${err.message}`);
      }
    }
  }
} else if (!flags.json && clusters.length > 0) {
  console.log('  (dry-run — add --write to emit files)');
}

// Exit
if (flags.gate && unbanked.length > 0) {
  const names = unbanked.map((c) => c.name).join(', ');
  gateFail(
    `lesson-foundry: ${unbanked.length} recurring lesson(s) unbanked: ${names}`,
    unbanked.map((c) => ({ name: c.name, route: c.route, size: c.size }))
  );
}

if (flags.json) {
  process.exit(0);
} else {
  pass('lesson-foundry: done.');
}
