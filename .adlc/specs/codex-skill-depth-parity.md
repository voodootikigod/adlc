# Spec — Codex skill-depth parity (T51)

**Phase:** P1 contract for bringing `plugins/adlc-codex`'s skill documentation up to
`plugins/adlc-claude-code`'s depth.

## Problem

`plugins/adlc-codex/skills/adlc/SKILL.md` (47 lines) is a terse stub next to
`plugins/adlc-claude-code/skills/adlc/SKILL.md` (162 lines), which has a concrete
"Where am I? → which gate" P0-P7 table with exact CLI invocations and exit-code
semantics, the trust-root cross-model gating explanation, and skill-mining guidance.
Codex also has no dedicated content matching Claude Code's `commands/adlc-ticket.md`
(180 lines: ticket store locking/atomic-write protocol, formatter-exclusion warnings,
coldstart integration) or `commands/adlc-maintain.md` (skill-rot, model-ratchet,
ticket-prune, gate-fuzzing) — that content is compressed to a handful of lines each
inside `adlc-spec/SKILL.md` and `adlc-distill/SKILL.md`.

## Placement decisions

- **P0 ticket-authoring content** extends the existing `plugins/adlc-codex/skills/
  adlc-spec/SKILL.md` rather than becoming a new skill. Rationale: `adlc-spec` already
  owns P0-P2 per its description ("Run ADLC P0-P2 specification, interrogation, ticket
  decomposition..."), and Codex's skill count/openai.yaml wiring stays stable — no new
  skill directory, no new `agents/openai.yaml` needed.
- **P7 maintenance content** extends the existing `plugins/adlc-codex/skills/
  adlc-distill/SKILL.md`, which already lists `skill-rot`/`model-ratchet`/
  `review-calibration`/`gate-fuzzing` commands in its description — this ticket expands
  the terse command list into the full walkthrough (exit-code semantics, cron-vs-session
  split) without splitting into a new skill.
- All content is adapted, not copy-pasted: every Claude-Code-only `/adlc:adlc-*`
  slash-command reference becomes Codex's `$adlc-*` skill-invocation convention, matching
  the `default_prompt` pattern already used in each skill's `agents/openai.yaml`.

## Deliverables

1. `plugins/adlc-codex/skills/adlc/SKILL.md` rewritten with the full P0-P7 gate table
   (exact `adlc <tool>` invocations and exit codes per phase), the trust-root cross-model
   gating explanation, and skill-mining/P7 guidance, Codex-flavored.
2. `plugins/adlc-codex/skills/adlc-spec/SKILL.md` extended with the ticket
   store locking/atomic-write protocol and formatter-exclusion warning content from
   `commands/adlc-ticket.md`, adapted to Codex's `$adlc-*` invocation convention.
3. `plugins/adlc-codex/skills/adlc-distill/SKILL.md` extended with the full
   skill-rot/model-ratchet/ticket-prune/gate-fuzzing walkthrough from
   `commands/adlc-maintain.md`, including exit-code semantics and the cron-vs-session
   split.
4. `docs/integrations/codex.md` and `apps/docs/content/docs/integrations/codex.mdx`
   updated if skill content changes materially affect the documented skill list.

## Acceptance criteria

- **AC1:** `plugins/adlc-codex/skills/adlc/SKILL.md` contains a P0-P7 gate table with
  concrete `adlc <tool>` invocations for every phase Claude Code's version documents.
  VERIFY: a content-presence smoke test asserting each of the P0..P7 section markers
  exist.
- **AC2:** `adlc-spec/SKILL.md` covers the same P0 protocol steps (lock acquisition/
  release, atomic write, edge validation, coldstart integration, formatter-exclusion
  check) as `commands/adlc-ticket.md`. VERIFY: smoke test asserting required section
  headers.
- **AC3:** `adlc-distill/SKILL.md` covers all four P7 checks with exit-code semantics.
  VERIFY: same pattern.
- **AC4:** No skill under `plugins/adlc-codex/skills` references a Claude-Code-only
  `/adlc:...` invocation form. VERIFY: `grep -r '/adlc:' plugins/adlc-codex/skills`
  returns zero matches, asserted in the smoke test.
- **AC5:** `adlc rails-guard --base main --ticket T51` passes; `npm test` passes;
  `node scripts/codex-install-smoke.mjs .` still passes.

## Out of scope

- Any hook/agent code changes (T48-T50 own those) — this ticket is documentation-only.
- Renaming or removing any existing skill.
