#!/usr/bin/env node
// CI rail-freeze backstop. This is the unbypassable commit-time gate that the
// in-session PreToolUse rail hook relies on: a Bash write form the hook does not
// recognize (node -e, python, cp, perl -i, …) still lands in the diff, and this
// gate rejects the PR if that diff touches a frozen rail.
//
// It reads every rail glob declared in .adlc/tickets.json and runs the
// diff-based `rails-guard` gate against the base ref.
//
//   node scripts/rails-guard-ci.mjs [base-ref]      (default base: origin/main)
//
// Exit: 0 = no rails declared OR no rail touched · 2 = a rail was modified ·
//       1 = operational error.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const base = process.argv[2] || process.env.RAILS_BASE || 'origin/main';
const ticketsPath = '.adlc/tickets.json';

if (!existsSync(ticketsPath)) {
  console.log('rails-guard-ci: no .adlc/tickets.json — nothing frozen.');
  process.exit(0);
}

let rails = [];
try {
  const data = JSON.parse(readFileSync(ticketsPath, 'utf8'));
  for (const t of data?.tickets ?? []) {
    for (const r of t?.rails ?? []) if (typeof r === 'string') rails.push(r);
  }
} catch (e) {
  console.error(`rails-guard-ci: cannot read ${ticketsPath}: ${e.message}`);
  process.exit(1);
}

rails = [...new Set(rails)];
if (rails.length === 0) {
  console.log('rails-guard-ci: no rails declared — nothing frozen.');
  process.exit(0);
}

const argv = ['--base', base, ...rails.flatMap((r) => ['--rails', r])];

// Prefer the in-repo bin (this repo); fall back to a globally installed `adlc`.
const localBin = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'rails-guard',
  'bin',
  'rails-guard.mjs'
);
const result = existsSync(localBin)
  ? spawnSync(process.execPath, [localBin, ...argv], { stdio: 'inherit' })
  : spawnSync('adlc', ['rails-guard', ...argv], { stdio: 'inherit' });

if (result.error) {
  console.error(`rails-guard-ci: could not run rails-guard: ${result.error.message}`);
  process.exit(1);
}
process.exit(typeof result.status === 'number' ? result.status : 1);
