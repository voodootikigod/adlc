# Spec — Codex satellite-skill depth parity (T51)

**Phase:** P1 contract for enriching `plugins/adlc-codex`'s `adlc-spec` and
`adlc-distill` skills — NOT the phase router.

**Revision note:** this replaces a draft that proposed rewriting
`plugins/adlc-codex/skills/adlc/SKILL.md` to carry a full P0-P7 phase table.
That file is a **generated** router (`scripts/router/gen-routers.mjs`, from
`scripts/router/router-model.mjs`). `docs/specs/router-consolidation.md`
documents an explicit, tested design decision: codex and pi are deliberately
"minimal" delegating routers with no phase map, while claude-code/antigravity/
opencode/cursor are "full-map" routers — `scripts/router/check-consolidation.mjs`
has a dedicated check (AC5 in that spec) that **fails** if a full phase map is
injected into codex/pi's router. The original AC1 here would have both fought
a deliberate decision and broken an existing test. Dropped.

## Problem

Claude Code's `commands/adlc-ticket.md` (180 lines: ticket-store locking/
atomic-write protocol, formatter-exclusion warning, coldstart integration)
and `commands/adlc-maintain.md` (skill-rot/model-ratchet/ticket-prune/
gate-fuzzing walkthrough with exit-code semantics) have no equivalent depth
in Codex — that content is compressed to a handful of lines each inside
`plugins/adlc-codex/skills/adlc-spec/SKILL.md` and `adlc-distill/SKILL.md`.

## Verified: these two files are safe to hand-edit

`grep -n "adlc-spec/SKILL.md\|adlc-distill/SKILL.md" scripts/router/router-model.mjs`
returns no matches — neither file is a generated target. Only the six paths
in `router-model.mjs`'s `harnesses` map are generated (one `adlc` router per
harness). Confirm this same way for any *other* file before editing anything
under `plugins/adlc-codex/skills/` in this ticket — do not assume.

## Deliverables

1. `plugins/adlc-codex/skills/adlc-spec/SKILL.md` — extend with the ticket
   store locking/atomic-write protocol (lock acquisition/release, atomic
   temp-file-then-rename write, edge validation, no-dependency-cycle check)
   and the formatter-exclusion warning from `commands/adlc-ticket.md`,
   adapted to Codex's `$adlc-*` invocation convention (no `/adlc:...`
   Claude-Code-only forms).
2. `plugins/adlc-codex/skills/adlc-distill/SKILL.md` — extend with the full
   `skill-rot`/`model-ratchet`/`ticket-prune`/`gate-fuzzing` walkthrough from
   `commands/adlc-maintain.md`, including each tool's exit-code semantics and
   the cron-vs-scheduled-session split for the LLM-backed gate-fuzzing check.

## Acceptance criteria

- **AC1:** `adlc-spec/SKILL.md` covers the same P0 protocol steps (lock
  acquisition/release, atomic write, edge validation, coldstart integration,
  formatter-exclusion check) as `commands/adlc-ticket.md`. VERIFY: a
  content-presence smoke test asserting required section headers exist.
- **AC2:** `adlc-distill/SKILL.md` covers all four P7 checks with exit-code
  semantics. VERIFY: same pattern.
- **AC3:** No skill under `plugins/adlc-codex/skills` references a
  Claude-Code-only `/adlc:...` form. VERIFY: `grep -r '/adlc:'
  plugins/adlc-codex/skills` returns zero matches, in the smoke test.
- **AC4:** The router (`plugins/adlc-codex/skills/adlc/SKILL.md`) is
  UNCHANGED. VERIFY: `git diff --stat main -- plugins/adlc-codex/skills/adlc/SKILL.md`
  is empty; `node scripts/router/gen-routers.mjs --check` still passes.
- **AC5:** `adlc rails-guard --base main --ticket T51` passes; `npm test`
  passes; `node scripts/codex-install-smoke.mjs .` still passes.

## Out of scope

- `scripts/router/router-model.mjs` or any generated router file.
- Hook/agent code (T54-T50).
- Renaming/removing any skill.
- T54/T49/T50/T52/T53.
