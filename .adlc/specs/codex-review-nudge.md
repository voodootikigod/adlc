# Spec — Codex Stop-time adversarial-review nudge (T50)

**Phase:** P1 contract for porting the Stop-time adversarial-review notice to
`plugins/adlc-codex`, using the canonical `@adlc/core` risk-tier module and
following Cursor's `stopAudit` shape as the primary reference.

**Revision note:** replaces an earlier draft written before
`packages/core/lib/risk-tier.mjs` and `plugins/adlc-cursor/hooks/adlc-stop.mjs`
were read directly.

## Problem

Codex's Stop hook (`adlc-lifecycle.mjs`, `verify` mode) only shells to
`adlc gate-manifest verify --json` and prints an advisory on failure. It has
no equivalent of the mechanical trigger from voodootikigod/adlc#59: when a
session's changed files fall in a risk-gated category (auth/trust-boundary,
security-control deny-path, secrets, data-loss/destructive, schema-migration,
CI/CD supply-chain) and no satisfying `adversarial-review` gate-manifest
record exists, surface a notice.

## Canonical source and prior art

`packages/core/lib/risk-tier.mjs` is the single canonical implementation:
`RISK_TIER_PATTERNS`, `matchRiskTier`, `classifyRiskTier`,
`decideAdversarialReviewNotice`. Its own header comment says outright:
Claude Code's hook can't resolve `@adlc/core` at runtime, so it carries a
verbatim `KEEP IN SYNC` copy (confirmed at `adlc-hook.mjs:438`); OpenCode's
`plugins/adlc-opencode/lib/session-hooks.mjs` imports the module directly.

`plugins/adlc-cursor/hooks/adlc-stop.mjs` implements the same feature for
Cursor and is the better reference for *shape*, not just for confirming the
canonical source:
- One `stopAudit(root, opts)` function covers both the gate-manifest-verify
  check and the risk-gated notice, rather than Claude Code's two separate
  Stop-hook modes (`manifest` + `review`).
- Its `gitChangedPaths` uses `git status --porcelain --no-renames -z` (NUL-
  delimited) plus `git ls-files --others --exclude-standard -z` plus a
  merge-base diff — no manual quote-unescaping, unlike Claude Code's
  `unquoteGitStatusPath`. This is strictly more robust and is what Codex's
  port should follow.
- Active-ticket resolution degrades a conflict to `null` (advisory: never
  fail closed) rather than erroring: `active.conflict ? null : active.id`.

Cursor's plugin can `import` `@adlc/core` directly in a hook file — its
install mechanism differs from Codex's (confirmed for T49: Codex installs via
git marketplace, not `npm install`, so the installed hook location has no
`node_modules`). Codex's port therefore inline-copies from
`packages/core/lib/risk-tier.mjs` (same `KEEP IN SYNC` pattern as T49's
build-gate copy), while following Cursor's cleaner algorithm shape.

## Design

Extend `plugins/adlc-codex/hooks/adlc-lifecycle.mjs` with a `review`
capability (kept as a separate `mode` argument value, consistent with the
file's existing `context`/`flail`/`verify` mode dispatch — not merged into
`verify`, so Stop's two hooks.json entries stay independently timeoutable and
one failing does not silently swallow the other's output):

1. Inline `KEEP IN SYNC` copies of `RISK_TIER_PATTERNS`, `matchRiskTier`,
   `classifyRiskTier`, `decideAdversarialReviewNotice` from
   `packages/core/lib/risk-tier.mjs`.
2. A `gitChangedPaths(root)` helper following Cursor's `-z` NUL-delimited
   approach (working tree status, untracked files, merge-base diff against
   the first reachable trunk candidate).
3. Active-ticket resolution reusing the same `resolveActiveTicketId` inline
   copy T49 already added to this hooks directory (import it from
   `adlc-build-gate.mjs` or duplicate the same small function — the spec
   prefers duplication with a `KEEP IN SYNC` comment over cross-hook-file
   imports, since each hook script must remain independently invocable
   without assuming another hook file's module shape is stable), degrading a
   conflict to `null` rather than failing the Stop hook.

## Deliverables

1. `review` mode added to `plugins/adlc-codex/hooks/adlc-lifecycle.mjs`.
2. `plugins/adlc-codex/hooks/hooks.json` — add the `review` invocation to the
   Stop entry alongside the existing `verify` command.
3. `plugins/adlc-codex/hooks/test/review-notice.test.mjs` — a drift test
   (inline copy vs. `packages/core/lib/risk-tier.mjs`'s real exports across
   shared fixtures) plus: notice fires on risk-gated changes with no record,
   notice suppressed when a satisfying record exists, `gitChangedPaths`
   handles quoted/renamed paths via the `-z` form, ticket-conflict degrades to
   `null` instead of failing the whole Stop hook.
4. `plugins/adlc-codex/skills/adlc/SKILL.md` and `adlc-prosecute/SKILL.md`
   updated to mention the automatic Stop-time nudge.

## Acceptance criteria

- **AC1:** A session touching risk-gated files with no satisfying
  `adversarial-review` gate-manifest record gets a `systemMessage` nudge at
  Stop. VERIFY: `plugins/adlc-codex/hooks/test/review-notice.test.mjs`.
- **AC2:** The notice is suppressed once a satisfying record exists. VERIFY:
  same test file.
- **AC3:** The inline copy's `matchRiskTier`/`classifyRiskTier`/
  `decideAdversarialReviewNotice` are IDENTICAL to
  `packages/core/lib/risk-tier.mjs`'s real exports across shared fixtures.
  VERIFY: same test file.
- **AC4:** The existing `verify` Stop behavior is unchanged; both hooks run at
  Stop. VERIFY: hooks.json entry + existing `verify` tests unmodified.
- **AC5:** `adlc rails-guard --base main --ticket T50` passes; `npm test`
  passes at the root.

## Out of scope

- A hard gate (stays advisory).
- Changing `packages/core/lib/risk-tier.mjs` or
  `plugins/adlc-cursor/hooks/adlc-stop.mjs`.
- T54/T49/T51/T52/T53.
