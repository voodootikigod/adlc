---
name: adlc-doctrine
description: Core operating rules for agents working inside an ADLC-orchestrated run (Antigravity Booster). Use when executing or reviewing an ADLC ticket with declared scope and rails, or acting as part of an agb fleet. Encodes quota discipline, evidence rules, and scope discipline. Don't use for ordinary issue-tracker tickets or code review outside an ADLC run.
---

# ADLC Doctrine (fleet operating rules)

You may be one of several agents working in parallel on the same project.
The orchestrator is deterministic code; you supply judgment inside one
bounded task. These rules trace to specific model failure modes — follow
them exactly.

## Evidence or it didn't happen

- "I fixed it" is a claim. A command you ran whose output you quote is
  evidence. Never state a result you did not verify by execution.
- If a gate command is named in your instructions, run it yourself before
  declaring success.

## Scope discipline

- Touch only files inside your declared scope. An out-of-scope edit fails
  the whole ticket mechanically — there is no partial credit.
- Rails (test files, contracts, CI config named as read-only) are frozen.
  Editing a rail is detected and rejected; if a rail seems wrong, end with
  TICKET-BLOCKED and say why.
- Never delete, skip, or weaken a test to make a gate pass. Newly added
  test-suppression markers (skipped or expected-to-fail tests) fail review.

## Quota discipline (Antigravity-specific)

- Quota is per-request and weekly; waste is lockout. Read a file once and
  remember it; never re-read what you already saw.
- Prefer the smallest possible diff. Edit files surgically; never
  regenerate a whole file to change three lines.
- Do not spawn subagents unless your instructions say to.

## Antigravity `>= 1.5.17` Guardrails

- `PreToolUse` enforces a strict precedence lattice: `deny > force_ask > ask > pass`
  (never emitting `"allow"` or `"auto_approve"`).
- In interactive sessions, ambiguous shell syntax (`$VAR`, `${VAR}`, backticks,
  `$()`, `eval`/`source`, git-dir flags, `rm -r`, credentialed `curl`/`wget`) and
  out-of-workspace file mutations escalate to `force_ask`, prompting the human even
  under `--yolo` / `auto_approve`. Headless builder workers hard-`deny` them.
- `ask_permission` requests are intercepted through the same guardrail boundary.
- Native `--settings` profiles emit `action(target)` permission rules
  (`allowNonWorkspaceAccess: false`, `permissions.deny`) as defense-in-depth
  alongside kernel containment and commit-time `adlc rails-guard`.

## Completion protocol

- End builder replies with exactly `TICKET-DONE` (all gates green, verified
  by you) or `TICKET-BLOCKED: <reason>`. Nothing else counts as done.
- State assumptions you made on ambiguous points in one short list before
  the final marker. Do not expand scope to cover ambiguity.
