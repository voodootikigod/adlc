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
//
// #326 sub-classification of the ticket-store surfaces. The add-vs-alter
// calibration applies ONLY to ACTIVE ticket CONTENT the caller's signal (computed
// from the ACTIVE store) can observe. The store INDEX and the ARCHIVE are
// signal-blind and tier UNCONDITIONALLY, so suppressing them on an additive
// verdict would fail OPEN (an archive rewrite or a store-backend swap looks
// "additive" to the active-tickets signal).
const ACTIVE_SHARD_PREFIX = '.adlc/tickets/';       // active shards → add-vs-alter calibrated
const ACTIVE_STORE_INDEX = '.adlc/tickets/.store.json'; // structural (migration) → unconditional
const ARCHIVE_PREFIX = '.adlc/ticket-archive/';     // rewrites gate history → unconditional

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

// Add-vs-alter calibration (#326). An ADDITIVE ticket-store write — a NEW ticket,
// with no existing ticket's contract altered or removed — grants no privilege over
// existing rails, exactly the distinction scripts/rails-guard-ci.mjs already draws
// (a PR may add a ticket but never alter an existing one). Treating it as trust-root
// tier would force a cross-model review on nearly every PR, which is why the gate
// was never enforced. So the ticket-store surfaces (the exact `.adlc/tickets.json`
// file and the `.adlc/tickets/` + `.adlc/ticket-archive/` prefixes) tier ONLY when
// an existing ticket contract is altered.
//
// The caller — which has the base and head trees — decides this and passes the
// verdict as `ticketContractAltered`:
//   • true      → an existing ticket was altered/removed → tier.
//   • false     → additive only → the ticket-store surfaces do NOT tier.
//   • undefined → the caller could not compute it → FAIL CLOSED (tier), and keep
//                 the legacy "touches trust-root …" wording for compatibility.
// This narrowing is scoped to the ticket-store surfaces only; enforcement/producer
// packages and rails deny-paths are unaffected.
const TICKET_STORE_FILES = new Set(['.adlc/tickets.json']);

/**
 * Classify a change as trust-root tier.
 *
 * @param {object} args
 * @param {string[]} [args.changedFiles]  repo-relative POSIX paths
 * @param {object[]} [args.tickets]       the base ticket array (rails deny-path source)
 * @param {boolean} [args.ticketContractAltered]  whether an existing ticket contract
 *   was altered/removed (add-vs-alter calibration, #326). Omit → fail closed.
 * @returns {{ isTrustRootTier: boolean, reasons: string[] }}
 */
export function classifyTrustRootTier({ changedFiles = [], tickets = [], ticketContractAltered } = {}) {
  const reasons = [];
  const push = (reason) => { if (!reasons.includes(reason)) reasons.push(reason); };

  // Additive-only ticket-store writes do not tier; true/undefined fail closed.
  const ticketStoreTiers = ticketContractAltered !== false;
  const ticketStoreReason = (surface) => (ticketContractAltered === true
    ? `alters an existing ticket contract in ${surface}`
    : `touches trust-root ticket store ${surface}`);

  for (const raw of changedFiles) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const path = toPosix(raw);

    if (TRUST_ROOT_FILES.includes(path)) {
      if (TICKET_STORE_FILES.has(path)) {          // .adlc/tickets.json — active content
        if (ticketStoreTiers) push(ticketStoreReason(path));
      } else {
        push(`touches trust-root file ${path}`);
      }
    }
    // Archive: unconditional (rewrites gate history; the active-tickets signal is
    // blind to it, so an archive mutation must never be declassified as additive).
    if (path.startsWith(ARCHIVE_PREFIX)) push(`touches trust-root ticket archive ${ARCHIVE_PREFIX}`);
    // Active store INDEX: unconditional (a .store.json change is structural, not an
    // additive ticket write). Checked before the shard branch since it shares the prefix.
    if (path === ACTIVE_STORE_INDEX) push(`touches trust-root ticket store index ${ACTIVE_STORE_INDEX}`);
    // Active shards: add-vs-alter calibrated via the observable signal.
    else if (path.startsWith(ACTIVE_SHARD_PREFIX) && ticketStoreTiers) push(ticketStoreReason(ACTIVE_SHARD_PREFIX));
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
