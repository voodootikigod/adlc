# Spec — Codex risk-tier build gate (T49)

**Phase:** P1 contract for porting Claude Code's `buildgate` enforcing hook to
`plugins/adlc-codex`.

## Problem

`plugins/adlc-claude-code/hooks/adlc-hook.mjs` implements a `buildgate` PreToolUse mode:
it computes a ticket's risk tier (`computeRiskTierForBuildGate`), counts mutating tool
calls made so far in the session against a per-tier budget
(`countToolCallsForBuildGate`), and hard-denies further mutating calls once the budget is
exceeded (`denyBuildGate`), recording any bypass to the gate-manifest
(`recordBuildGateBypass`). `plugins/adlc-codex` has no equivalent: its only PreToolUse
hook, `adlc-rails-guard.mjs`, protects frozen *paths*, not session-level risk/tool-call
budgets.

## Shared-logic decision

`plugins/adlc-claude-code/hooks/adlc-hook.mjs`'s buildgate functions are private to that
file — there is no existing shared package backing the tiering/budget computation.
This spec directs the risk-tier and budget-table logic to move into a new shared module,
`packages/build-gate/lib/tier.mjs`, exporting `computeRiskTier(ticket)` and
`budgetForTier(tier)`. `plugins/adlc-claude-code/hooks/adlc-hook.mjs`'s buildgate mode is
refactored to import from this shared module instead of its private
`computeRiskTierForBuildGate`/`countToolCallsForBuildGate` implementations, and
`plugins/adlc-codex/hooks/adlc-build-gate.mjs` imports the same functions. The tiering
rule and budget numbers are unchanged from Claude Code's current values — this is a pure
extraction, not a redesign.

## State-tracking decision

Tool-call counts are tracked per Codex's existing `PLUGIN_DATA`-style state-file
convention already used by `adlc-lifecycle.mjs`'s `flailOutput` (a JSON state file under
`process.env.PLUGIN_DATA ?? join(root, '.adlc/.plugin-data')`), keyed by ticket id and
reset when the ticket changes. No second state-file convention is introduced.

## Deny payload and bypass

`adlc-build-gate.mjs` denies using the same output shape as `adlc-rails-guard.mjs`'s
`fail()` (Codex's PreToolUse deny convention), not Claude Code's `denyBuildGate` JSON
shape — the two harnesses' hook protocols differ and this hook must speak Codex's.
Bypass is controlled by a new `ADLC_BUILDGATE_BYPASS=1` environment variable (distinct
from `ADLC_RAILS_BYPASS`, since build-gate and rail-freeze are independent concerns with
independent audit trails) and recorded via `adlc gate-manifest record buildgate-bypass`.

## Deliverables

1. `packages/build-gate/lib/tier.mjs` — extracted `computeRiskTier`/`budgetForTier`,
   consumed by both plugins.
2. `plugins/adlc-claude-code/hooks/adlc-hook.mjs` refactored to import from
   `packages/build-gate/lib/tier.mjs` instead of its private tiering functions (behavior
   unchanged).
3. `plugins/adlc-codex/hooks/adlc-build-gate.mjs` — new hook implementing the deny path
   using the shared tiering module and the `PLUGIN_DATA` state convention.
4. `plugins/adlc-codex/hooks/hooks.json` — wire `adlc-build-gate.mjs` into the existing
   PreToolUse entry alongside `adlc-rails-guard.mjs`.
5. `plugins/adlc-codex/hooks/test/build-gate.test.mjs` — tier computation, budget-exceeded
   deny, bypass recording, timeout/kill-signal fail-closed behavior.
6. `plugins/adlc-codex/skills/adlc-rail-build/SKILL.md` updated to document the gate and
   `ADLC_BUILDGATE_BYPASS`.

## Acceptance criteria

- **AC1:** A ticket at a given risk tier that exceeds its tool-call budget gets its next
  mutating PreToolUse call hard-denied by `adlc-build-gate.mjs`. VERIFY:
  `plugins/adlc-codex/hooks/test/build-gate.test.mjs`.
- **AC2:** A recorded bypass appears in `.adlc/manifest.jsonl` with gate name, ticket id,
  and reason. VERIFY: same test file, bypass-path assertions.
- **AC3:** Risk-tier computation is shared, not forked, between both plugins. VERIFY:
  both `adlc-hook.mjs` and `adlc-build-gate.mjs` import `packages/build-gate/lib/tier.mjs`
  — asserted by a test importing both and checking function reference equality.
- **AC4:** `adlc rails-guard --base main --ticket T49` passes; `npm test` passes at the
  root; existing `plugins/adlc-codex/hooks/test/*.test.mjs` suite passes unmodified in
  behavior.
- **AC5:** Hook timeout/kill-signal path fails closed (denies), matching Claude Code's
  `ENFORCING_MODES` timeout handling in `adlc-hook-run.mjs`. VERIFY: new test simulating a
  timeout.

## Out of scope

- Redesigning the risk-tier rule or budget numbers.
- T48/T50/T51/T52.
