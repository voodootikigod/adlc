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

const BASE = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'main';

/** Gates that block a PR, in the order CI runs them. */
const GATES = [
  {
    name: 'tests',
    why: 'the full workspace suite',
    argv: ['node', ['scripts/run-tests.mjs']],
  },
  {
    name: 'rail-freeze',
    why: 'no frozen rail edited, and no EXISTING ticket contract changed',
    argv: ['node', ['scripts/rails-guard-ci.mjs', `origin/${BASE}`]],
  },
  {
    name: 'mutation-gate',
    why: 'changed code has tests that notice it being broken',
    argv: ['node', ['scripts/mutation-gate.mjs', '--base', BASE]],
  },
];

/**
 * The rail-freeze and mutation gates both diff against `origin/<base>`. A stale
 * or missing remote ref makes them compare against the wrong tree and quietly
 * pass — the exact "green locally, red in CI" gap this script exists to close.
 */
function refreshBase() {
  try {
    execFileSync('git', ['fetch', '--no-tags', 'origin', `${BASE}:refs/remotes/origin/${BASE}`], { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.error(`preflight: could not fetch origin/${BASE} — gates would compare against a stale base.`);
    console.error(`  ${String(e.stderr ?? e.message).trim()}`);
    return false;
  }
}

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
