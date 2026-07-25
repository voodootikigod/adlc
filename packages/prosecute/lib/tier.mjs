// tier.mjs — trust-root-tier classifier (T39).
//
// Pure, offline, deterministic. Decides whether a change (its changed-file set
// plus the ticket table) is "trust-root tier": the high-risk surface where a
// clean same-model P5 is not enough and a cross-model adversarial approve is
// REQUIRED. This is the binary trust-root decision only — NOT the model
// frontier/direct/ladder taxonomy in @adlc/core's risk-tier.mjs (a different
// concept that this file deliberately does not touch; core is frozen).

import { globMatch } from '@adlc/core';

// 1. Exact trust-root files: the rails-guard CI backstop, its workflow template,
//    and the workflow hash pin — the code/config surfaces whose meaning a
//    same-model review of the author's own change cannot independently check.
//
// The ticket STORE (`.adlc/tickets.json`, the sharded `.adlc/tickets/`, and
// `.adlc/ticket-archive/`) is deliberately NOT here (#326). rails-guard-ci already
// owns that surface with an add-vs-alter contract: a PR may ADD a ticket (which
// grants no privilege over existing rails) but can never ALTER or REMOVE an
// existing ticket's contract — only the protected-base admin ceremony can. So a
// ticket-store change is either privilege-neutral (an addition) or already blocked
// (an alteration); routing it through the cross-model tier as well made every
// ADLC-ticketed PR trust-root tier for no added protection, and — because the
// reviewed revision excludes the ticket store — could not even be soundly
// attested. Producer packages that WRITE the store still tier (below).
const TRUST_ROOT_FILES = [
  'scripts/rails-guard-ci.mjs',
  'docs/ci/rails-guard.yml',
  'scripts/test/rails-guard-workflow-hashes.json',
  // The ROOT install manifests (#326 Codex F1). CI runs candidate `npm install`
  // BEFORE the gate, so a `scripts.postinstall` in the root package.json — or a
  // dependency repointed by the lockfile — executes inside the gate's own job and
  // could poison the toolchain the gate imports. Neither file is a tier surface by
  // package-prefix and (verified) neither is in CODEOWNERS, so a PR touching only
  // them would otherwise merge with no cross-model review. EXACT-match only: a
  // NESTED package.json tiers solely via its package prefix, not this rule. The gate
  // step additionally reinstalls with --ignore-scripts as defense-in-depth.
  'package.json',
  'package-lock.json',
];

// 2. Enforcement packages: each emits an exit-2 gate. Editing them changes what
//    "the gate passes" means, so a same-model review of the author's own tests
//    is exactly the blind spot cross-model review exists to cover.
const ENFORCEMENT_PREFIXES = [
  'packages/rails-guard/',
  'packages/prosecute/',
  'packages/gate-manifest/',
  'packages/build-gate/',
];

// 3. Producers of a gated artifact: they write .adlc/tickets.json, so a bug here
//    poisons the input every gate trusts.
const PRODUCER_PREFIXES = [
  'packages/ticket-prune/',
  'packages/ticket-sync/',
];

function toPosix(file) {
  return String(file).replaceAll('\\', '/');
}

// A TEST file: under a `test/` directory segment, or a `*.test.{mjs,js,cjs}`
// basename (the repo's test conventions). Test-only changes to a producer/
// enforcement package cannot alter the produced artifact or the gate LOGIC, so
// they do not create the producer↔consumer CONTRACT mismatch the cross-model
// tier exists to gate (a hollow test is caught by P5 prosecution/mutation
// instead). This exemption applies ONLY to the package-PREFIX surfaces below —
// NOT to the exact trust-root files (a test-path file like
// scripts/test/rails-guard-workflow-hashes.json still tiers) nor to the rails
// deny-path surface (a test path that IS a declared rail still tiers). #154/T41.
//
// STATED ASSUMPTION (safety of this exemption rests on it): a `test/` path or a
// `*.test.*` basename holds TEST code that is NEVER imported by production
// `lib/`/`bin/`. A test-named module can only affect the produced artifact if a
// NON-test file imports it — and that importer edit is itself non-test, so it
// tiers. The invariant "no production code imports a test-classified module in a
// producer/enforcement package" is ENFORCED by a guard test (see
// tier.test.mjs), so a future convention violation can't silently open a bypass.
//
// FAIL-SAFE on non-canonical paths: a path containing a `..` segment is not a
// clean test path (e.g. `test/../lib/run.mjs` resolves into production); refuse
// to exempt it (tier it) rather than risk exempting production. The live caller
// feeds two-dot `git diff --name-only` output (already canonical), so this is
// defense-in-depth for out-of-contract input.
function isTestFile(path) {
  if (/(^|\/)\.\.(\/|$)/.test(path)) return false;
  return /(^|\/)test\//.test(path) || /\.test\.(mjs|js|cjs)$/.test(path);
}

/**
 * Classify a change as trust-root tier.
 *
 * The ticket STORE is intentionally not a tier surface (#326) — rails-guard-ci
 * owns it with an add-vs-alter contract, so ticket-store changes are either
 * privilege-neutral additions or already-blocked alterations. See TRUST_ROOT_FILES.
 *
 * @param {object} args
 * @param {string[]} [args.changedFiles]  repo-relative POSIX paths
 * @param {object[]} [args.tickets]       the ticket array (rails deny-path source)
 * @returns {{ isTrustRootTier: boolean, reasons: string[] }}
 */
export function classifyTrustRootTier({ changedFiles = [], tickets = [] } = {}) {
  const reasons = [];
  const push = (reason) => { if (!reasons.includes(reason)) reasons.push(reason); };

  for (const raw of changedFiles) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const path = toPosix(raw);

    if (TRUST_ROOT_FILES.includes(path)) push(`touches trust-root file ${path}`);
    // Package-prefix surfaces gate on LOGIC/CONTRACT risk; a test-only change
    // touches neither, so it is exempt here (#154/T41). The exact-file check
    // above and the rails-deny-path check below stay unconditional.
    const contractRelevant = !isTestFile(path);
    for (const prefix of ENFORCEMENT_PREFIXES) {
      if (contractRelevant && path.startsWith(prefix)) push(`touches enforcement package ${prefix}`);
    }
    for (const prefix of PRODUCER_PREFIXES) {
      if (contractRelevant && path.startsWith(prefix)) push(`touches gated-artifact producer package ${prefix}`);
    }
    for (const ticket of Array.isArray(tickets) ? tickets : []) {
      const rails = Array.isArray(ticket?.rails) ? ticket.rails : [];
      for (const glob of rails) {
        if (typeof glob === 'string' && glob && globMatch(glob, path)) {
          push(`touches rails deny-path of ticket ${ticket.id}: ${glob}`);
        }
      }
    }
  }

  return { isTrustRootTier: reasons.length > 0, reasons };
}
