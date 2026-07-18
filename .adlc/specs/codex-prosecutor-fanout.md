# Spec — Codex P5 multi-lens prosecutor fan-out (T54)

**Phase:** P1 contract for porting Claude Code's multi-lens adversarial P5 prosecution
architecture to `plugins/adlc-codex`.

## Problem

Codex's P5 review is a single generic agent (`plugins/adlc-codex/agents/adlc-reviewer.toml`)
that mixes correctness, security, contract-drift, rollback-risk, and hollow-test concerns
into one prompt. There is no fan-out across independent lenses, no cross-lens dedupe, and
no independent verification of findings before they're reported.

Claude Code's equivalent (`plugins/adlc-claude-code/agents/prosecutor{,-correctness,
-security,-contract,-diff,-tests,-verifier}.md`) fans out five independent read-only
lens subagents, dedupes findings by `findingKey`, verifies each deduped finding
independently via a fresh-context verifier (strict majority vote via
`survivesVerification`), and loops until two consecutive dry rounds
(`shouldContinue`). All orchestration logic (`dedupeFindings`, `survivesVerification`,
`shouldContinue`, `findingKey`) is pure and lives in `@adlc/core`
(`packages/core/lib/prosecutor.mjs`); Claude Code's plugin only re-exports it via
`plugins/adlc-claude-code/lib/prosecutor.mjs`. `plugins/adlc-codex/skills/adlc-prosecute/
SKILL.md` currently states outright that the skill "does not run the reviewer by
itself" — the actual multi-lens review is not native to Codex today.

## Invocation mechanism decision

Codex has no primitive identical to Claude Code's Task-tool subagent fan-out. This spec
resolves the CONTRACT question from T54 as follows: the `adlc-prosecute` skill instructs
the operating Codex session to invoke each of the six `agents/adlc-prosecutor-*.toml`
profiles in turn, using Codex's existing agent-profile invocation convention (the same
mechanism `adlc-explorer`/`adlc-reviewer`/`adlc-verifier` already use), collecting each
lens's JSON findings array before running dedupe. This is a documented, explicit
sequential loop instructed by the skill — not a claim of automatic parallel execution,
since Codex has no such primitive. Each deduped finding then gets one independent
verifier invocation via `agents/adlc-prosecutor-verifier.toml`. The skill instructs the
operator to repeat the lens pass whenever new findings survive verification, and to stop
after two consecutive rounds produce zero surviving findings — mirroring
`shouldContinue`'s loop-until-dry semantics, applied by the operating session rather than
by a host-level loop primitive Codex doesn't have.

## Deliverables

1. `plugins/adlc-codex/agents/adlc-prosecutor-{correctness,security,contract,diff,
   tests}.toml` — five read-only (`sandbox_mode = "read-only"`) lens agents, each with a
   `developer_instructions` block adapted from the corresponding
   `plugins/adlc-claude-code/agents/prosecutor-*.md` brief: same hunted failure classes,
   same JSON finding schema (`severity`, `file`, `line_start`, `line_end`, `title`,
   `body`, `evidence`, `recommendation`).
2. `plugins/adlc-codex/agents/adlc-prosecutor-verifier.toml` — adapted from
   `prosecutor-verifier.md`: independent refutation per deduped finding, default to
   refuted on weak evidence, returns `{ real, reason, repro }`.
3. `plugins/adlc-codex/lib/prosecutor.mjs` — re-exports `LENSES`, `VERIFIER`,
   `ALL_AGENTS`, `findingKey`, `dedupeFindings`, `survivesVerification`,
   `shouldContinue` from `@adlc/core` by reference, mirroring
   `plugins/adlc-claude-code/lib/prosecutor.mjs` exactly in structure (aliased `export
   const` bindings, not `export { X } from`).
4. `plugins/adlc-codex/skills/adlc-prosecute/SKILL.md` rewritten to document the full
   fan-out → dedupe → independent-verify → loop-until-two-dry-rounds sequence per the
   Invocation mechanism decision above, naming each of the six agent files explicitly,
   before describing `adlc prosecute` evidence recording.
5. `plugins/adlc-codex/lib/test/prosecutor-delegation.test.mjs` — reference-equality
   assertions between the shim's exports and `@adlc/core`'s, mirroring
   `plugins/adlc-claude-code/lib/test/prosecutor-delegation.test.mjs`.
6. Docs: `docs/integrations/codex.md` and
   `apps/docs/content/docs/integrations/codex.mdx` updated to describe the sequential,
   skill-instructed fan-out (not automatic parallel execution).

## Acceptance criteria

- **AC1:** All six `plugins/adlc-codex/agents/adlc-prosecutor-*.toml` files exist,
  each `sandbox_mode = "read-only"`, each with a `developer_instructions` block naming
  its lens's specific hunted failure classes. VERIFY: `node --test
  plugins/adlc-codex/agents/test/profiles.test.mjs` (new).
- **AC2:** `plugins/adlc-codex/lib/prosecutor.mjs` exports the same bindings as
  `plugins/adlc-claude-code/lib/prosecutor.mjs`, verified by reference equality against
  `@adlc/core`. VERIFY: `node --test
  plugins/adlc-codex/lib/test/prosecutor-delegation.test.mjs`.
- **AC3:** `plugins/adlc-codex/skills/adlc-prosecute/SKILL.md` documents the full
  sequence and no longer states the skill "does not run the reviewer by itself" without
  qualification. VERIFY: a smoke test asserting required section markers are present in
  the SKILL.md body.
- **AC4:** `adlc rails-guard --base main --ticket T54` passes; `npm test` passes at the
  root.
- **AC5:** `packages/core/lib/prosecutor.mjs` is untouched — dedupe/verify/loop logic is
  reused, not reimplemented. VERIFY: prosecutor-delegation test plus `git diff --stat
  packages/core/lib/prosecutor.mjs` empty on the ticket's branch.

## Out of scope

- Changing `plugins/adlc-claude-code`'s prosecutor implementation.
- Building a generic cross-harness subagent-fan-out primitive for Codex.
- T52's MCP/compaction work.
