// risk-tier.mjs — deterministic (no-LLM) risk-tier path-pattern matcher, per
// ADR-0007 §1 / ADR-0008's coverage map. Pure, no I/O: given repo-relative
// changed paths (and, for the notice decision, already-loaded gate-manifest
// entries), decide whether a change is "risk-gated" — i.e. whether ADR-0007's
// operator-invoked adversarial-review practice applies — and whether that
// practice has already been satisfied for the current ticket/revision.
//
// This is the mechanical trigger primitive for voodootikigod/adlc#59: the six
// risk categories are the same ones ADR-0005/0007/0008 already named as the
// trust-boundary trigger; nothing here invents a new policy, it just makes the
// existing one checkable without a human remembering to run the CLI.
//
// KEEP IN SYNC: `plugins/adlc-claude-code/hooks/adlc-hook.mjs` cannot resolve
// @adlc/core at runtime (same constraint as its ported `globMatch` — see that
// file's own header comment), so RISK_TIER_PATTERNS/matchRiskTier/
// classifyRiskTier/decideAdversarialReviewNotice are ported VERBATIM there.
// `plugins/adlc-opencode/lib/session-hooks.mjs` imports this module directly.

import { globMatch } from './tickets.mjs';

/**
 * ADR-0007 §1 risk-tier categories → representative path glob patterns (the
 * `globMatch` glob dialect: '*' within a segment, '**' across segments).
 * Deliberately a conservative FLOOR, not an exhaustive classifier: false
 * negatives are expected and operator judgment still applies on anything this
 * misses; the goal is a deterministic mechanical trigger for the categories
 * ADR-0007/0008 already named, not a perfect-recall path classifier.
 */
export const RISK_TIER_PATTERNS = Object.freeze({
  'auth-trust-boundary': Object.freeze([
    '**/auth/**', '**/authn/**', '**/authz/**', '**/oauth/**', '**/sso/**',
    '**/session/**', '**/login/**', '**/permissions/**', '**/rbac/**', '**/acl/**',
  ]),
  'security-control-deny-path': Object.freeze([
    '**/*guard*', '**/*validator*', '**/*validators*', '**/sandbox/**', '**/sandboxes/**',
    '**/middleware/**', '**/*deny-path*', '**/*policy*', '**/policies/**',
  ]),
  secrets: Object.freeze([
    '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
    '**/secrets/**', '**/secret/**', '**/*credentials*', '**/vault/**',
  ]),
  'data-loss-destructive': Object.freeze([
    '**/*delete*', '**/*destroy*', '**/*purge*', '**/*truncate*', '**/*wipe*',
    '**/*irreversible*',
  ]),
  'schema-migration': Object.freeze([
    '**/migrations/**', '**/migrate/**', '**/*.sql', '**/schema.*', '**/*.prisma',
  ]),
  'ci-cd-supply-chain': Object.freeze([
    '.github/workflows/**', '**/Dockerfile', '**/Dockerfile.*', '**/docker-compose*.yml',
    '**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
    '**/requirements*.txt', '**/Gemfile*', '**/go.sum', '**/go.mod', '**/Cargo.lock',
    '.circleci/**', '.gitlab-ci.yml',
  ]),
});

/**
 * Classify ONE repo-relative path against every risk tier.
 * @param {string} path
 * @returns {{tier: string, pattern: string}|null} the first matching tier/pattern, or null.
 */
export function matchRiskTier(path) {
  const norm = String(path).split('\\').join('/');
  for (const [tier, patterns] of Object.entries(RISK_TIER_PATTERNS)) {
    for (const pattern of patterns) {
      if (globMatch(pattern, norm)) return { tier, pattern };
    }
  }
  return null;
}

/**
 * Classify a SET of changed paths.
 * @param {string[]} [paths]
 * @returns {{gated: boolean, matches: Array<{path: string, tier: string, pattern: string}>}}
 *   `gated` is true iff at least one path matched at least one risk tier.
 */
export function classifyRiskTier(paths) {
  const matches = [];
  for (const path of paths ?? []) {
    const hit = matchRiskTier(path);
    if (hit) matches.push({ path, ...hit });
  }
  return { gated: matches.length > 0, matches };
}

/**
 * The hook-mode decision: given the changed paths and the (already-loaded)
 * gate-manifest entries, decide whether a mechanical adversarial-review notice
 * is warranted. Pure — callers own the I/O (git diffing, `adlc gate-manifest
 * show`), which is what makes this directly unit-testable against a mocked
 * manifest state.
 *
 * A recorded `adversarial-review` entry satisfies the requirement when: the
 * active ticket is unknown (any record counts — nothing to scope it to); the
 * entry itself has no ticket recorded (an untargeted/global review still
 * counts); or the entry's ticket matches the active ticket. It does NOT
 * satisfy the requirement when the entry is recorded against a DIFFERENT
 * ticket than the one currently active.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.changedPaths]
 * @param {object[]} [opts.manifestEntries]  parsed gate-manifest entries ({gate, ticket, ...})
 * @param {string|null} [opts.ticketId]  the active ticket id, or null if none resolved
 * @returns {{needed: boolean, matches: Array<{path: string, tier: string, pattern: string}>}}
 */
export function decideAdversarialReviewNotice({ changedPaths = [], manifestEntries = [], ticketId = null } = {}) {
  const { gated, matches } = classifyRiskTier(changedPaths);
  if (!gated) return { needed: false, matches: [] };

  const hasRecord = (manifestEntries ?? []).some(
    (e) => e && e.gate === 'adversarial-review' && (!ticketId || !e.ticket || e.ticket === ticketId)
  );
  return { needed: !hasRecord, matches };
}
