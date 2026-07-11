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
    for (const prefix of ENFORCEMENT_PREFIXES) {
      if (path.startsWith(prefix)) push(`touches enforcement package ${prefix}`);
    }
    for (const prefix of PRODUCER_PREFIXES) {
      if (path.startsWith(prefix)) push(`touches gated-artifact producer package ${prefix}`);
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
