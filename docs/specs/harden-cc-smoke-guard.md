# Spec — harden claude-code-plugin-smoke.mjs's bare-command guard (issue #96)

## Issue

The regression guard added in #89 (closing #50) scanned only a hardcoded allowlist
of "extra" doc paths (`docs/integrations/claude-code.md`, `README.md`, the design
ADR) plus a hardcoded list of command names (`['init', 'ticket', 'distill',
'maintain']`). Every adversarial-review round after the first, across both #89 and
this change's own build, found a new surface the allowlist didn't know about —
most notably a **live, unfixed bug**: `/adlc-prosecute` (added by #61) was missing
from the command-name list, so bare `/adlc-prosecute` references in
`docs/integrations/claude-code.md` and the command file's own heading were never
caught.

## Fix

1. **Command names derived from `plugins/adlc-claude-code/commands/*.md`** instead
   of a hardcoded array — a new command file is covered automatically.
2. **Doc-wide scan** of `docs/**/*.md` + `README.md` (+ `AGENTS.md`/`CLAUDE.md` if
   present), replacing the 3-file allowlist, with an explicit, reviewed exclusion
   list (`EXCLUDED_DOC_PATHS`) for paths that are genuinely not Claude-Code-specific
   live guidance — archived/superseded docs, other harnesses' own integration docs,
   planning/spec scratch docs, and harness-agnostic package reference docs. Each
   exclusion entry states its reason inline.
3. Fixed the live `/adlc-prosecute` bug found by the above: 9 files across
   `plugins/adlc-claude-code/agents/*`, `lib/prosecutor.mjs`,
   `commands/adlc-prosecute.md`'s own heading, and `docs/integrations/claude-code.md`.

## Acceptance criteria

1. A bare command reference in any new doc under `docs/`, anywhere, fails the guard
   with no allowlist entry required.
2. A bare reference to a newly-added command (a command file the guard has never
   seen before) fails the guard with no hardcoded name-list update required.
3. Genuinely out-of-scope docs (archived docs, other harnesses' own integration
   docs) do not false-positive, even though they contain real bare-command text.
4. The guard passes clean against the current repo (no regressions from the doc
   fixes made alongside the guard change).

## Verification

```sh
node --test scripts/test/claude-code-plugin-smoke.test.mjs   # 13/13 pass
node scripts/claude-code-plugin-smoke.mjs .                    # exit 0
npm test                                                       # full repo suite, exit 0
```
