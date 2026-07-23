#!/usr/bin/env node
// preflight — run every gate that BLOCKS a pull request, locally, in one command.
//
// WHY THIS EXISTS. CONTRIBUTING told contributors to run `npm test` before
// pushing, but CI blocks a PR on three independent required gates: the test
// suite, the rail-freeze trust-root check, and the diff-scoped mutation gate.
// Two of the three were documented nowhere and had no local entry point, so
// doing exactly what CONTRIBUTING said still left you surprised by CI.
//
// WHAT IT DEFENDS — the near-miss that motivated it. `adlc rails-guard` and
// `scripts/rails-guard-ci.mjs` sound interchangeable and are not: the CI script
// additionally forbids any change to an EXISTING ticket's contract in
// .adlc/tickets.json (the rail trust root). A PR authored against a stale view
// of the ticket store reused an id another branch had already claimed, silently
// rewriting that ticket's contract. The friendlier `adlc rails-guard` reported
// "all checks passed" the whole time, because it answers a different and weaker
// question. The weaker check was the more discoverable one — so the fix is to
// make the STRONGER set the thing you actually run.
//
// Gates run in CI's order, cheapest first, and the run STOPS at the first
// failure: a red suite makes the later gates' output noise.
//
// Live-canary jobs (codex/opencode) are deliberately excluded — they need
// network and provider credentials, so they cannot be a local precondition.
// Everything here is hermetic.

import { spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Base branch name (not a ref) — `--base <name>`, default `main`. */
export function parseBase(argv) {
  const i = argv.indexOf('--base');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : 'main';
}

/**
 * The gates that block a PR, in the order CI runs them.
 *
 * Each argv MIRRORS ci.yml exactly. That is load-bearing, and getting it subtly
 * wrong is the very failure this script exists to prevent: mutation-gate reads
 * its base as the first NON-FLAG positional (`args.find(a => !a.startsWith('--'))`,
 * defaulting to `origin/main`), so passing `--base main` would silently hand it
 * the bare branch name and diff against a different ref than CI does.
 */
export function buildGates(base) {
  return [
    {
      name: 'tests',
      why: 'the full workspace suite',
      argv: ['node', ['scripts/run-tests.mjs']],
    },
    {
      name: 'rail-freeze',
      why: 'no frozen rail edited, and no EXISTING ticket contract changed',
      argv: ['node', ['scripts/rails-guard-ci.mjs', `origin/${base}`]],
    },
    {
      name: 'mutation-gate',
      why: 'changed code has tests that notice it being broken',
      argv: ['node', ['scripts/mutation-gate.mjs', `origin/${base}`, '--max', '12']],
    },
  ];
}

const BASE = parseBase(process.argv);
const GATES = buildGates(BASE);

/**
 * The rail-freeze and mutation gates both diff against `origin/<base>`. A stale
 * or missing remote ref makes them compare against the wrong tree and quietly
 * pass — the exact "green locally, red in CI" gap this script exists to close.
 */
export function refreshBase(base = BASE, run = defaultFetch) {
  try {
    run(base);
    return true;
  } catch (e) {
    console.error(`preflight: could not fetch origin/${base} — gates would compare against a stale base.`);
    console.error(`  ${String(e.stderr ?? e.message).trim()}`);
    return false;
  }
}

function defaultFetch(base) {
  execFileSync('git', ['fetch', '--no-tags', 'origin', `${base}:refs/remotes/origin/${base}`], { stdio: 'pipe' });
}

// Importable for tests; only the direct invocation runs the gates.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) { /* imported — expose the helpers above without running anything */ }
else main();

function main() {
console.log(`preflight: running the ${GATES.length} gates that block a PR (base: origin/${BASE})\n`);

if (!refreshBase()) process.exit(1);

const started = Date.now();
for (const [i, gate] of GATES.entries()) {
  console.log(`── [${i + 1}/${GATES.length}] ${gate.name} — ${gate.why}`);
  const [cmd, args] = gate.argv;
  const r = spawnSync(cmd, args, { stdio: 'inherit' });

  if (r.error) {
    console.error(`\npreflight: FAILED to run ${gate.name}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\n✖ preflight: ${gate.name} FAILED (exit ${r.status}) — this gate blocks the PR.`);
    if (gate.name === 'rail-freeze') {
      console.error('  Note: this is STRICTER than `adlc rails-guard`. As well as frozen-rail');
      console.error('  edits it rejects any change to an existing ticket in .adlc/tickets.json.');
      console.error('  A ticket id claimed by another branch is the usual cause — re-read the');
      console.error('  store after fetching and pick a genuinely free id.');
    }
    process.exit(r.status);
  }
  console.log(`✔ ${gate.name}\n`);
}

console.log(`✔ preflight: all ${GATES.length} PR-blocking gates passed in ${Math.round((Date.now() - started) / 1000)}s`);
}
