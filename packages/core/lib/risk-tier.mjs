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
 * Does a manifest entry's recorded `files` map (from `gate-manifest record
 * ... --files a,b,c`, see packages/gate-manifest/lib/record.mjs) overlap the
 * currently gated paths? An entry with NO `files` recorded (the common case
 * today — the documented `--evidence`-only recording convention in
 * docs/toolkit.md doesn't require `--files`) is neither confirmed nor refuted
 * by this check, so it's treated as "not scoped either way" (returns true —
 * falls back to ticket-only scoping in decideAdversarialReviewNotice). An
 * entry that DOES record files but shares none with the current gated
 * matches was demonstrably reviewing a different changeset, so it must not
 * silently satisfy this one.
 * @param {object} entry
 * @param {Array<{path: string}>} matches
 * @returns {boolean}
 */
function filesOverlapOrUnscoped(entry, matches) {
  const files = entry && entry.files;
  if (!files || typeof files !== 'object') return true;
  const recorded = Object.keys(files);
  if (recorded.length === 0) return true;
  const gatedPaths = new Set(matches.map((m) => m.path));
  return recorded.some((p) => gatedPaths.has(p));
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
 * The manifest has no field naming which commit/diff a review covered, so
 * ticket-scoping alone can't tell a review of THIS change apart from a stale
 * or unrelated review recorded under the same (or no) ticket — see
 * filesOverlapOrUnscoped's doc comment. As an ADDITIONAL (never looser)
 * constraint on top of the ticket rule above: when an entry carries a
 * `files` map (i.e. it was recorded with `--files`), that map must overlap
 * the currently gated paths to count; entries recorded without `--files`
 * are unaffected and keep falling back to ticket-only scoping, so existing
 * recording conventions (docs/toolkit.md) keep working unchanged.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.changedPaths]
 * @param {object[]} [opts.manifestEntries]  parsed gate-manifest entries ({gate, ticket, files, ...})
 * @param {string|null} [opts.ticketId]  the active ticket id, or null if none resolved
 * @returns {{needed: boolean, matches: Array<{path: string, tier: string, pattern: string}>}}
 */
export function decideAdversarialReviewNotice({ changedPaths = [], manifestEntries = [], ticketId = null } = {}) {
  const { gated, matches } = classifyRiskTier(changedPaths);
  if (!gated) return { needed: false, matches: [] };

  const hasRecord = (manifestEntries ?? []).some(
    (e) =>
      e &&
      e.gate === 'adversarial-review' &&
      (!ticketId || !e.ticket || e.ticket === ticketId) &&
      filesOverlapOrUnscoped(e, matches)
  );
  return { needed: !hasRecord, matches };
}
