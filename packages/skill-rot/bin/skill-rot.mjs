#!/usr/bin/env node
/**
 * skill-rot — ADLC C10 skill cache invalidation gate.
 *
 * Usage: skill-rot [path ...] [--write] [--json]
 *
 * Exit codes:
 *   0 — all skills clean (gate passes)
 *   1 — operational error (nothing found, bad input)
 *   2 — gate fails (at least one stale skill)
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { parseArgs, printJson } from '@adlc/core';
import { DEFAULT_ROOTS, findSkills } from '../lib/find-skills.mjs';
import { checkSkill } from '../lib/rot-checker.mjs';
import { formatTable, formatJson } from '../lib/format.mjs';

const { values, positionals } = parseArgs({
  options: {
    write: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const repoRoot = process.cwd();

// Determine search roots: positionals override defaults
const isExplicit = positionals.length > 0;
const searchRoots = isExplicit ? positionals : DEFAULT_ROOTS;

if (isExplicit) {
  for (const root of positionals) {
    const absRoot = resolve(repoRoot, root);
    if (!existsSync(absRoot)) {
      const msg = `explicit search path does not exist: ${absRoot}`;
      if (values.json) {
        printJson({ error: 'explicit search path does not exist', path: root, resolved: absRoot });
      } else {
        console.error(`error: ${msg}`);
      }
      process.exit(1);
    }
  }
}

let skillPaths;
try {
  skillPaths = findSkills(searchRoots, repoRoot, { strict: isExplicit });
} catch (err) {
  // strict mode: an explicit path that exists but is not a skills directory or
  // SKILL.md — an operational error (exit 1), never a silent pass.
  if (values.json) {
    printJson({ error: 'explicit search path is not a skills directory or SKILL.md', detail: err.message });
  } else {
    console.error(`error: ${err.message}`);
  }
  process.exit(1);
}

if (skillPaths.length === 0) {
  const searchedPaths = searchRoots
    .map((r) => resolve(repoRoot, r))
    .join(', ');
  const msg = `nothing to verify — no SKILL.md files found.\nSearched: ${searchedPaths}\nPass explicit paths as arguments, e.g.: skill-rot .claude/skills .agents/skills`;
  if (values.json) {
    printJson({ error: 'nothing to verify', searched: searchRoots });
  } else {
    console.error(msg);
  }
  process.exit(1);
}

const results = skillPaths.map((p) =>
  checkSkill(p, repoRoot, { write: values.write })
);

if (values.json) {
  printJson(formatJson(results, repoRoot));
} else {
  console.log(formatTable(results, repoRoot));
}

const anyStale = results.some((r) => r.stale > 0);
if (anyStale) {
  process.exit(2);
} else {
  process.exit(0);
}
