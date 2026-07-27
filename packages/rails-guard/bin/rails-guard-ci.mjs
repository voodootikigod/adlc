#!/usr/bin/env node
// `adlc rails-guard-ci` — the CI rail-freeze backstop, as a shipped command (#140).
//
// This bin exists so the gate has ONE implementation. It used to have two: this logic as
// scripts/rails-guard-ci.mjs, and a hand-mirrored `node -e` copy embedded in
// docs/ci/rails-guard.yml, kept honest by a sha256 fixture that could prove the copies
// were UNCHANGED but never that they AGREED. Every gate change meant editing both and
// regenerating the hash — which is exactly where a subtle divergence slips in, and did:
// #314 fixed a manifest fail-open in the script that the template never received.
//
// The workflow template now installs a pinned @adlc/cli and calls this. That is not a
// new trust dependency — the template already installed the same pinned package and
// already delegated the final verdict to `adlc rails-guard`.
//
//   adlc rails-guard-ci [--base <ref>] [--trust-root <path>]…
//   adlc rails-guard-ci bootstrap [--base <ref>]

import { USAGE, parseArgs } from '../lib/ci/args.mjs';
import { isGateError } from '../lib/ci/errors.mjs';
import { runBootstrapCheck } from '../lib/ci/bootstrap.mjs';
import { runRailFreezeGate } from '../lib/ci/rail-freeze.mjs';

function main(argv, { env, cwd }) {
  const parsed = parseArgs(argv, env);
  if (parsed.error) {
    console.error(`rails-guard-ci: ${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  if (parsed.command === 'help') {
    console.log(USAGE);
    return 0;
  }

  try {
    const result = parsed.command === 'bootstrap'
      ? { ...runBootstrapCheck({ cwd, base: parsed.base, env }), status: 0 }
      : runRailFreezeGate({ cwd, base: parsed.base, env, additionalTrustRoots: parsed.trustRoots });
    for (const message of result.messages) console.log(`rails-guard-ci: ${message}`);
    return result.status;
  } catch (error) {
    console.error(`rails-guard-ci: ${error.message}`);
    // A GateDeny/GateFail carries the verdict (2 / 1). Anything else is a crash inside
    // the gate — still not a pass, so it exits 1 rather than falling through to 0.
    return isGateError(error) ? error.exitCode : 1;
  }
}

process.exit(main(process.argv.slice(2), { env: process.env, cwd: process.cwd() }));
