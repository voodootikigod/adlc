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

// This repo's CI workflow, which is not part of the gate's built-in defaults (a
// downstream repo deploys .github/workflows/adlc-rails-guard.yml instead, which IS a
// default). It produces the ADLC_PR_REVIEWS the #141 ceremony reads, so tampering with it
// to forge reviews is itself a trust-root change.
//
// check-reviewer-directed-comments.mjs is a required CI gate whose own source and test
// otherwise sat completely unprotected: a PR could rewrite `check()` to return success
// and adjust its unit test in the same change, disabling the control without ever
// touching a protected file or needing the trust-root ceremony — the mutation gate is
// not an authorization boundary here, since the same change controls both the logic
// and the tests that verify it.
//
// The gate's OWN sources are deliberately NOT passed from here. They live in
// DEFAULT_IMMUTABLE_TRUST_ROOTS: passing them in made it possible for one PR to drop these
// arguments AND remove this wrapper from the defaults, unprotecting both enforcement
// sources at once (cross-model review, #363).
const REPO_TRUST_ROOTS = [
  '.github/workflows/ci.yml',
  'scripts/check-reviewer-directed-comments.mjs',
  'scripts/test/check-reviewer-directed-comments.test.mjs',
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
