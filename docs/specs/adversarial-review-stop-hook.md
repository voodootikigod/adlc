# Spec note — mechanical adversarial-review trigger (issue #59)

**Phase:** lightweight P1 record for a build already completed (not a pre-build design doc).

## Issue

`adversarial-review` (ADR-0005 / ADR-0007 / ADR-0008) was never triggered mechanically anywhere
in the repo — a deliberate, documented deferral contingent on "operator-reliance proving
insufficient." Issue #59 is that signal: adds a deterministic (no-LLM) local trigger at the risk
gate for both first-party session-hook integrations (Claude Code, OpenCode), so a risk-gated
change with no recorded review is surfaced without anyone remembering to run the CLI by hand.

## What shipped

- `packages/core/lib/risk-tier.mjs` — the single source of truth: `RISK_TIER_PATTERNS` (the
  ADR-0007 §1 categories — auth/trust boundary, security control/deny path, secrets, data-loss/
  destructive ops, schema/migration, CI/CD/supply-chain — as `globMatch` path globs),
  `matchRiskTier`/`classifyRiskTier` (pure path classification), and
  `decideAdversarialReviewNotice` (pure decision given changed paths + gate-manifest entries +
  active ticket).
- `plugins/adlc-claude-code/hooks/adlc-hook.mjs` — new fifth mode, `review` (Stop hook). Diffs
  the working tree/branch (git status + untracked + diff vs. the first reachable trunk
  candidate) against the risk-tier patterns (ported verbatim — this hook cannot resolve
  `@adlc/core` at runtime, same constraint as its existing `globMatch` port) and, if gated with no
  matching `adversarial-review` gate-manifest record, emits an advisory `systemMessage`. Advisory
  by default; emits a blocking Stop `decision: "block"` only when the operator opts in via
  `ADLC_ADVERSARIAL_REVIEW_ENFORCEMENT=1`.
- `plugins/adlc-opencode/lib/session-hooks.mjs` — new `auditAdversarialReview`, invoked from the
  `session.idle` hook in `plugins/adlc-opencode/index.mjs` alongside `checkPreflight`/
  `auditGateManifest`. Same decision logic via `@adlc/core`, always advisory (`session.idle` has
  no blocking contract).

## Acceptance criteria

- AC1: `matchRiskTier`/`classifyRiskTier` correctly classify representative paths for all six
  ADR-0007 risk tiers and return `null`/`gated:false` for ordinary paths (pure, no I/O).
- AC2: `decideAdversarialReviewNotice` is `needed:false` whenever a change isn't risk-gated, or an
  `adversarial-review` gate-manifest record already covers the active ticket (or is unscoped and
  no active ticket is known); `needed:true` otherwise — verified against a mocked manifest state,
  not a live ledger.
- AC3: The Claude Code `review` mode is silent when the repo isn't ADLC-initialized, nothing
  changed, or changes don't touch a risk tier; emits an advisory notice (never a stray
  `decision:"block"`) on an unreviewed risk-gated change; and emits `decision:"block"` only under
  `ADLC_ADVERSARIAL_REVIEW_ENFORCEMENT=1`.
- AC4: The OpenCode `auditAdversarialReview` check mirrors AC3's decision logic and is wired into
  `session.idle`; the plugin's hooks never throw regardless of outcome.
- AC5: No regression in the existing rails/preflight/flail/manifest hook tests or the rest of the
  monorepo test suite.

## Verification commands

```sh
node --test packages/core/test/risk-tier.test.mjs
node --test plugins/adlc-claude-code/hooks/test/review.test.mjs
node --test plugins/adlc-claude-code/hooks/test/*.test.mjs   # regression: rails still 43/43
node --test plugins/adlc-opencode/test/session-hooks.test.mjs
node --test packages/core/test/*.test.mjs
npm test   # full monorepo suite
```

All of the above pass (0 failures) as of this change.
