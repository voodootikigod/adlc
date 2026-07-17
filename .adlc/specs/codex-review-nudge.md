# Spec — Codex Stop-time adversarial-review nudge (T50)

**Phase:** P1 contract for porting Claude Code's Stop-hook `review()` advisory to
`plugins/adlc-codex`.

## Problem

Codex's Stop hook (`plugins/adlc-codex/hooks/adlc-lifecycle.mjs`, `verify` mode) only
shells out to `adlc gate-manifest verify --json` and prints an advisory on failure. It
has no equivalent to Claude Code's `review()` (`plugins/adlc-claude-code/hooks/
adlc-hook.mjs`, roughly lines 691-1112), which classifies git-diff-touched files by risk
tier, resolves the active ticket, and decides whether to surface a "you touched X without
recorded review evidence, run adversarial-review" notice — tracking cases where changes
overlap declared scope with no manifest entry, or are entirely unscoped.

## Mechanism

`gitChangedPaths` is ported verbatim in logic (parses `git status --porcelain`, handling
quoted paths with spaces and rename arrows `->`) into a new function in
`plugins/adlc-codex/hooks/adlc-lifecycle.mjs`. `matchRiskTier`/`classifyRiskTier` reuse
the same tiering module introduced by T49 (`packages/build-gate/lib/tier.mjs`) applied to
file paths rather than tickets, if that module's shape supports it; otherwise this ticket
ports Claude Code's path-based tier matcher independently — the implementer decides based
on what T49 actually ships and documents the choice inline. `resolveActiveTicketIdAdvisory`
reuses the existing `.adlc/current-ticket.json` read already present in `stateContext()`.
`decideAdversarialReviewNotice({ changedPaths, manifestEntries, ticketId })` is ported
verbatim: it fires when changed paths intersect a risk-tier-flagged glob and no matching
gate-manifest review entry exists for the ticket's current revision; it is suppressed when
a review entry already exists.

## Output composition

Both `verify` and the new `review` notice run at Stop and must be able to coexist in one
Stop hook response. Since Codex's `hookOutput()` currently returns a single
`{ systemMessage }` object per invocation and `hooks.json`'s Stop entry can list multiple
hook commands, each mode continues to run as its own hook invocation (matching the
existing pattern where `context`/`flail`/`verify` are separate `mode` arguments to the
same script) — `review` is added as a fourth mode, invoked as its own Stop hook entry, not
merged into `verify`'s output.

## Deliverables

1. New `review` mode in `plugins/adlc-codex/hooks/adlc-lifecycle.mjs`, porting
   `gitChangedPaths`, risk-tier classification, `resolveActiveTicketIdAdvisory`, and
   `decideAdversarialReviewNotice`.
2. `plugins/adlc-codex/hooks/hooks.json` — add the `review` invocation to the Stop entry
   alongside the existing `verify` command.
3. Tests in `plugins/adlc-codex/hooks/test/lifecycle.test.mjs`: notice fires on unscoped
   changes with no manifest entry; notice suppressed when the manifest already records
   review evidence; correct handling of quoted/renamed git-status paths.
4. Docs: `plugins/adlc-codex/skills/adlc/SKILL.md` and `adlc-prosecute/SKILL.md` updated
   to mention the automatic Stop-time nudge.

## Acceptance criteria

- **AC1:** A session that touched risk-tier-flagged files with no corresponding
  gate-manifest review entry receives a `systemMessage` nudge naming adversarial-review at
  Stop. VERIFY: `plugins/adlc-codex/hooks/test/lifecycle.test.mjs`, fixture-based.
- **AC2:** The notice is suppressed when the manifest already shows review evidence for
  the active ticket's current revision. VERIFY: same test file, suppressed-case
  assertion.
- **AC3:** The existing `verify` Stop behavior is unchanged; both advisories can coexist
  as separate Stop hook entries. VERIFY: hooks.json review + existing verify tests both
  passing unmodified.
- **AC4:** `adlc rails-guard --base main --ticket T50` passes; `npm test` passes at the
  root.

## Out of scope

- Making the notice a hard gate — it stays advisory.
- T48/T49/T51/T52.
