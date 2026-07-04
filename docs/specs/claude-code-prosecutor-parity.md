# Spec — Claude Code multi-lens prosecution parity (issue #61)

## Problem

Harness parity between the Claude Code and OpenCode ADLC plugins was inverted for P5
(pre-merge prosecution): OpenCode's `/adlc-prosecute` implemented a real multi-round
adversarial loop (fan out five independent lenses, dedupe findings across lenses,
independently verify each deduped finding, repeat until two consecutive rounds are dry),
while Claude Code's `prosecutor` subagent ran three deterministic gates sequentially with
no dedupe, no independent verifier-refutation, and no convergence loop — and its own text
said it did not satisfy formal P5 and punted to the Codex path.

## What this closes

Ports the OpenCode multi-lens loop into `plugins/adlc-claude-code/`:

- `commands/adlc-prosecute.md` — the `/adlc-prosecute` command: fan-out → dedupe →
  independent-verify → loop-until-dry, same shape as
  `plugins/adlc-opencode/command/adlc-prosecute.md`.
- `agents/prosecutor-{correctness,security,contract,diff,tests,verifier}.md` — six
  read-only (`tools: Read, Grep, Glob`, no Edit/Write/MultiEdit/Bash) Claude Code
  subagents, adapted from the six `plugins/adlc-opencode/agent/prosecutor-*.md` lens
  prompts to Claude Code's `name`/`description`/`tools` frontmatter convention (not a
  byte-for-byte copy of OpenCode's `mode`/`permission` frontmatter, which doesn't apply).
- `lib/prosecutor.mjs` — the pure, unit-tested dedupe/verify/convergence contract
  (`findingKey`, `dedupeFindings`, `survivesVerification`, `shouldContinue`), ported from
  `plugins/adlc-opencode/lib/prosecutor.mjs` so the decision logic — not just the prompt
  text — is identical and independently testable across harnesses.
- `agents/prosecutor.md` lines 87-90 caveat rewritten: it no longer claims Claude Code
  cannot satisfy the multi-lens loop or must punt to a different harness; it now points at
  `/adlc-prosecute` for the loop and clarifies that formal `adlc run p5` phase assertion is
  a harness-agnostic runner path (`adlc prosecute` → `adlc run p5`), not exclusive to any
  one CLI.
- `docs/integrations/claude-code.md` updated to match (commands table, prosecutor
  section, lifecycle coverage table, Gaps section).
- `scripts/claude-code-plugin-smoke.mjs` extended to assert the new command and six agent
  files exist, are well-formed (frontmatter shape, no Edit/Write/MultiEdit/Bash grant on
  the lenses/verifier), and that `lib/prosecutor.mjs` exports the full contract and is
  wired into the root `package.json` test script.

## Acceptance criteria

1. `/adlc-prosecute` and all six `prosecutor-*` subagents exist under
   `plugins/adlc-claude-code/` with Claude Code-native frontmatter, and the command text
   names all six subagents and describes dedupe, independent verification, and
   loop-until-dry convergence (not just fan-out).
2. The dedupe/verify/convergence logic is pure, exported from `lib/prosecutor.mjs`, and
   unit-tested — same behavior as OpenCode's registry (5 lenses + verifier, dedupe by
   file+line-range+normalized-title keeping highest severity, strict-majority verifier
   survival with fail-closed-to-survive on zero valid votes, two-consecutive-dry-round
   loop termination).
3. `plugins/adlc-claude-code/agents/prosecutor.md` no longer claims the Codex path is
   required to run the multi-lens adversarial loop.
4. `scripts/claude-code-plugin-smoke.mjs` fails if any new command/agent/lib file is
   missing, malformed, or grants a prosecution lens Edit/Write/MultiEdit/Bash.
5. No regression in any existing test in the workspace (`packages/*`, `plugins/adlc-*`,
   `scripts/*`, `apps/docs`).

## Verification

```sh
node --test plugins/adlc-claude-code/lib/test/prosecutor.test.mjs   # RED before impl, GREEN after
node scripts/claude-code-plugin-smoke.mjs .                          # new command/agent/lib guards
node --test scripts/test/claude-code-plugin-smoke.test.mjs
node --test plugins/adlc-claude-code/hooks/test/*.test.mjs           # no regression
npm test                                                             # full workspace suite
```
