---
description: Slice an approved spec into executable ticket partitions (P2) and forecast the merge.
argument-hint: "[ticket-or-request]"
---

# /adlc-decompose — decompose into tickets (P2)

Turn an approved spec into a set of small, independently-executable tickets with
explicit ordering, then forecast how they merge. Target: `$ARGUMENTS` (default to
the active ticket). See the `adlc-spec` skill for the command reference.

## 1. Slice
Break the work into tickets small enough for one fresh agent context. For each,
follow the `/adlc-ticket` contract (self-contained body, concrete acceptance
criteria, `scope`, `rails`, `edges`, `duration`). Wire `edges` as prerequisite→
dependent; tickets that touch the same scope should be serialized to avoid
concurrent merge conflicts.

## 2. Check executability — `coldstart`
For each new ticket run `adlc coldstart <id> --json` (or `--prompt-only` to answer
the audit yourself — in pi you are the working model), and close any gaps that
would block a fresh agent. Add `--record-verdict <file|->` to capture the verdict
into `.adlc/manifest.jsonl` so executability is auditable.

## 3. Forecast — `merge-forecast` + `model-router`
- Run `adlc merge-forecast --json`: confirm a clean DAG (no cycles, no high-risk
  concurrent same-scope pairs). Serialize with edges if it flags conflicts.
- Run `adlc model-router --json` (deterministic — no `--prompt-only` mode; flags
  are `--tickets`/`--floor`/`--json`) to get a tier/route hint per ticket
  (cheap / mid / frontier).

## 4. Summarize
Report the ticket DAG (waves + merge order), each ticket's coldstart verdict, and
the routing hints. The next phase is P3: declare the ticket's `rails` (the frozen
paths) and verify them with `adlc rails-guard`; then build under
`/adlc-verify-build` (P4). Note: the pi extension enforces those rails in-session
once the ticket is active — see the `adlc-rail-build` skill.
