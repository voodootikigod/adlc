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

// Gate check: which clusters have no existing defense file?
const unbanked = flags.gate
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
          // Dedup a spec-gap question when its cluster OVERLAPS an already-distilled one by
          // ANY member hash — the same durable identity banking uses (route.mjs
          // clusterMembers). Two weaker keys were tried and both re-append duplicates:
          //  - the greedy `cluster: ([^)]+)\)` swept in the mutable member list, so a cluster
          //    GAINING a finding stopped matching (round-13); and
          //  - the stable cluster-id fixes append but NOT an out-of-order ledger merge — now
          //    that the ledger is tracked in git, a branch merge can introduce an
          //    EARLIER-timestamped member, which changes the founding occurrence and thus the
          //    cluster-id, orphaning the prior question (round-14).
          // Member overlap survives both: neither append nor merge REMOVES the members the
          // existing question already covers.
          const membersOf = (line) => {
            const m = line.match(/cluster-members: ([0-9a-f ]+)/);
            return m ? m[1].trim().split(/\s+/).filter(Boolean) : [];
          };
          const legacyKeyOf = (line) => {
            const id = line.match(/cluster-id: ([0-9a-f]+)/);
            if (id) return `cluster-id: ${id[1]}`;
            const name = line.match(/cluster: ([^,)]+)/);
            return name ? `cluster: ${name[1].trim()}` : line.trim();
          };
          const existingMembers = new Set(
            existing.split('\n').filter((l) => l.startsWith('- [ ]')).flatMap(membersOf),
          );
          const alreadyPresent = (line) => {
            const members = membersOf(line);
            // Overlap on the member set when we have one; else fall back to the id/name key
            // (legacy or hand-written questions carrying no cluster-members annotation).
            return members.length > 0
              ? members.some((h) => existingMembers.has(h))
              : existing.includes(legacyKeyOf(line));
          };
          const newLines = file.content
            .split('\n')
            .filter((l) => l.startsWith('- [ ]'))
            .filter((l) => !alreadyPresent(l));
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
