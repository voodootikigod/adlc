#!/usr/bin/env node
// CI rail-freeze backstop. This is the unbypassable commit-time gate the
// in-session PreToolUse rail hook relies on: a Bash write form the hook does not
// recognize (node -e, python, cp, perl -i, …) still lands in the diff, and this
// gate rejects the PR if that diff touches a frozen rail.
//
// The rail set is read from the TRUSTED BASE version of .adlc/tickets.json (via
// `git show <base>:…`), never the PR's working tree — otherwise a PR could edit
// the ticket file to remove rails and self-disable the gate in the same change.
// Once base rails exist, the ADLC trust roots are also protected rails, so a PR
// that edits the rail set, security config, or manifest evidence is flagged for
// review. Malformed base tickets fail closed.
//
//   node scripts/rails-guard-ci.mjs [base-ref]      (default base: origin/main)
//
// Exit: 0 = no rails at base OR no rail touched · 2 = a rail was modified ·
//       1 = operational error / unverifiable rails (fails the CI job).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const base = process.argv[2] || process.env.RAILS_BASE || 'origin/main';

function fail(msg) {
  console.error(`rails-guard-ci: ${msg}`);
  process.exit(1);
}

function git(args, label) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 60000 });
  if (result.error) fail(`${label} failed: ${result.error.message}`);
  if (result.signal) fail(`${label} timed out or was killed by ${result.signal}`);
  return result;
}

// First confirm the base REF resolves. `git show <ref>:<path>` returns non-zero
// for BOTH "ref does not resolve" and "path absent at ref" — conflating them
// would fail OPEN (an unfetched/typo'd base would look like "no rails"). An
// unresolvable base means rails cannot be verified → fail closed.
const ref = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], 'git rev-parse base');
if (ref.status !== 0) {
  fail(`base ref '${base}' does not resolve — rails cannot be verified. Fetch it (or pass the correct base).`);
}

const configLs = git(['ls-tree', '--name-only', base, '--', '.adlc/config.json'], 'git ls-tree base config');
if (configLs.status !== 0) {
  fail(`git ls-tree failed for '${base}' config (operational error) — failing closed.`);
}
const baseHasConfig = Boolean(configLs.stdout.trim());

// Distinguish "the file is genuinely absent at base" from an operational git
// error. `git ls-tree` lists the path in the base tree: a non-zero status is an
// operational failure (lock, IO) → fail closed; empty output means the file is
// truly absent → nothing was frozen. Only `git show` an existing file, so a
// failure THERE is also operational → fail closed (never read as "no rails").
const ls = git(['ls-tree', '--name-only', base, '--', '.adlc/tickets.json'], 'git ls-tree base tickets');
if (ls.status !== 0) {
  fail(`git ls-tree failed for '${base}' (operational error) — failing closed.`);
}
if (!ls.stdout.trim()) {
  if (baseHasConfig) {
    console.log(`rails-guard-ci: no .adlc/tickets.json at ${base} — protecting ADLC trust roots only.`);
  } else {
    console.log(`rails-guard-ci: no .adlc/tickets.json at ${base} — nothing was frozen.`);
    process.exit(0);
  }
}

let show = { stdout: '{"tickets":[]}', status: 0 };
if (ls.stdout.trim()) {
  show = git(['show', `${base}:.adlc/tickets.json`], 'git show base tickets');
  if (show.status !== 0) {
    fail(`git show failed for an existing base ticket file (operational error) — failing closed.`);
  }
}

let data;
try {
  data = JSON.parse(show.stdout);
} catch (e) {
  fail(`cannot parse ${base}:.adlc/tickets.json (${e.message}) — failing closed.`);
}
if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.tickets)) {
  fail(`${base}:.adlc/tickets.json is not in the { "tickets": [...] } shape — failing closed.`);
}

const rails = [];
for (const t of data.tickets) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) fail('a base ticket entry is not an object — failing closed.');
  if (t.rails !== undefined && !Array.isArray(t.rails)) fail('a base ticket has a non-array "rails" field — failing closed.');
  for (const r of t.rails ?? []) {
    if (typeof r !== 'string') fail('a base ticket has a non-string rail entry — failing closed.');
    rails.push(r);
  }
}

const trustRoots = rails.length || baseHasConfig ? ['.adlc/tickets.json', '.adlc/config.json', '.adlc/manifest.jsonl'] : [];
const unique = [...new Set([...rails, ...trustRoots])];
if (unique.length === 0) {
  console.log(`rails-guard-ci: no rails declared at ${base} — nothing frozen.`);
  process.exit(0);
}

const argv = ['--base', base, ...unique.flatMap((r) => ['--rails', r])];

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
  ? spawnSync(process.execPath, [localBin, ...argv], { stdio: 'inherit', timeout: 120000 })
  : spawnSync('adlc', ['rails-guard', ...argv], { stdio: 'inherit', timeout: 120000 });

if (result.error) fail(`could not run rails-guard: ${result.error.message}`);
if (result.signal) fail(`rails-guard timed out or was killed by ${result.signal}`);
process.exit(typeof result.status === 'number' ? result.status : 1);
