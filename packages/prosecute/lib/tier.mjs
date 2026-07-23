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
//    the workflow hash pin, and the ticket table every downstream gate reads.
const TRUST_ROOT_FILES = [
  'scripts/rails-guard-ci.mjs',
  'docs/ci/rails-guard.yml',
  'scripts/test/rails-guard-workflow-hashes.json',
  '.adlc/tickets.json',
];

// 1b. The SHARDED ticket store — the same trust root as `.adlc/tickets.json`,
// just spread across per-ticket files. Exact-file matching cannot express it (one
// entry per ticket, and new shards appear as tickets are authored), so the whole
// store directory is a trust-root PREFIX. Without this, migrating a repo from the
// legacy file to the directory backend would silently declassify every edit to
// the ticket table: the exact-file entry above stops matching and nothing else
// covers `.adlc/tickets/`. The archive is included because a ticket moved there
// still describes what was enforced, so mutating it rewrites gate history.
//
// Unconditional, like TRUST_ROOT_FILES: these are DATA the gate reads, so the
// test-path exemption that applies to package prefixes must not apply here.
const TRUST_ROOT_PREFIXES = [
  '.adlc/tickets/',
  '.adlc/ticket-archive/',
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
 * @param {object} args
 * @param {string[]} [args.changedFiles]  repo-relative POSIX paths
 * @param {object[]} [args.tickets]       the array from .adlc/tickets.json
 * @returns {{ isTrustRootTier: boolean, reasons: string[] }}
 */
export function classifyTrustRootTier({ changedFiles = [], tickets = [] } = {}) {
  const reasons = [];
  const push = (reason) => { if (!reasons.includes(reason)) reasons.push(reason); };

  for (const raw of changedFiles) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const path = toPosix(raw);

    if (TRUST_ROOT_FILES.includes(path)) {
      push(`touches trust-root file ${path}`);
    }
    for (const prefix of TRUST_ROOT_PREFIXES) {
      if (path.startsWith(prefix)) push(`touches trust-root ticket store ${prefix}`);
    }
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
