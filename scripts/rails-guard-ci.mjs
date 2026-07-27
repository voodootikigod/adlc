#!/usr/bin/env node
// This repository's entry point into the CI rail-freeze backstop.
//
// The gate itself is `adlc rails-guard-ci` (@adlc/rails-guard, lib/ci/**) — one
// implementation, shared with the docs/ci/rails-guard.yml template that downstream
// repositories deploy (#140). This wrapper exists for two reasons and holds no gate
// logic of its own:
//
//   1. It is the stable path this repo's CI, hooks, and 1300 lines of regression tests
//      already invoke, with a POSITIONAL base ref (`node scripts/rails-guard-ci.mjs main`).
//   2. It declares the trust roots that are specific to THIS repository — the
//      enforcement sources that live in our own tree and that a downstream repo has no
//      equivalent of. Passing them on the command line is safe precisely because this
//      file is itself one of the built-in default trust roots: a PR cannot shrink the
//      list without editing a frozen file and tripping the #141 ceremony.
//
// Exit: 0 = no rail touched · 2 = a rail was modified · 1 = operational error.
//
// WARNING: this path runs the rail-freeze gate ONLY. It does NOT run the bootstrap
// step (`adlc rails-guard-ci bootstrap`), which owns CODEOWNERS self-protection, the
// signed runner-pool probe, and the first-bootstrap acknowledgement ceremony — those
// need a GitHub Actions pull_request context. Non-GitHub CI integrations must run the
// bootstrap subcommand too before treating this as a complete enforcement boundary.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Enforcement sources that live in this repo's tree. The gate's built-in defaults cover
// the paths every ADLC-using repo has (.adlc/config.json, CODEOWNERS, the deployed
// workflow, …); these are ours.
const REPO_TRUST_ROOTS = [
  // The workflow that runs THIS gate and produces the ADLC_PR_REVIEWS the #141 ceremony
  // reads. Since the authorization decision depends on this file's integrity, tampering
  // with it to forge reviews is itself a trust-root change.
  '.github/workflows/ci.yml',
  // The gate implementation, as source. Freezing the directory rather than a file list
  // means a NEW file added under it is frozen the moment it exists — a list would have
  // to be remembered, and the whole point of #140 is to stop relying on remembering.
  'packages/rails-guard/lib/ci/**',
  'packages/rails-guard/bin/rails-guard-ci.mjs',
  'packages/rails-guard/lib/trust-root-authorization.mjs',
  // The enforcement bin the gate spawns to render the final verdict. Freezing it is
  // defense in depth, and the in-gate freeze CANNOT be transitively complete: the bin
  // delegates to packages/rails-guard/lib/** (check.mjs -> rails.mjs / suppressions.mjs),
  // which in turn uses @adlc/tickets for the base-vs-head comparisons. That whole engine
  // rests on branch-protection CODEOWNERS review as its un-forgeable backstop — the same
  // merge gate this entire ceremony rests on. (See #326 for tightening the tier.)
  'packages/rails-guard/bin/rails-guard.mjs',
];

const base = process.argv[2] || process.env.RAILS_BASE || 'origin/main';
const bin = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'rails-guard',
  'bin',
  'rails-guard-ci.mjs'
);

const result = spawnSync(
  process.execPath,
  [bin, '--base', base, ...REPO_TRUST_ROOTS.flatMap((path) => ['--trust-root', path])],
  { stdio: 'inherit' }
);

if (result.error) {
  console.error(`rails-guard-ci: could not run the gate: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`rails-guard-ci: gate timed out or was killed by ${result.signal}`);
  process.exit(1);
}
process.exit(typeof result.status === 'number' ? result.status : 1);
