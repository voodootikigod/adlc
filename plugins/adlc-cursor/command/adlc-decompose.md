---
description: Slice an approved spec into executable ticket partitions (P2) and forecast the merge.
---

# /adlc-decompose — decompose into tickets (P2)

Turn an approved spec into a set of small, independently-executable tickets with
explicit ordering, then forecast how they merge. Target: the text after the
command (default to the active ticket).

## 1. Slice
Break the work into tickets small enough for one fresh agent context. For each,
follow the `/adlc-ticket` contract (self-contained body, concrete acceptance
criteria, `scope`, `rails`, `edges`, `duration`). Wire `edges` as prerequisite→
dependent; tickets that touch the same scope should be serialized to avoid
concurrent merge conflicts.

## 2. Check executability — `coldstart`
For each new ticket run `adlc coldstart <id> --prompt-only`, answer the audit
yourself (inside Cursor you are the model — no API key), and close any gaps that
would block a fresh agent. Add `--record-verdict <file|->` to capture your
answer into `.adlc/manifest.jsonl` so the executability verdict is auditable.

## 3. Forecast — `merge-forecast` + `model-router`
- Run `adlc merge-forecast --json`: confirm a clean DAG (no cycles, no high-risk
  concurrent same-scope pairs). Serialize with edges if it flags conflicts.
- Run `adlc model-router --json` (deterministic — it has no `--prompt-only`
  mode; flags are `--tickets`/`--floor`/`--json`) to get a tier/route hint per
  ticket (cheap / mid / frontier).

## 4. Summarize
Report the ticket DAG (waves + merge order), each ticket's coldstart verdict, and
the routing hints. The next phase is P3: declare the ticket's `rails` (the
frozen paths) and verify them with `adlc rails-guard`; then build under
`/adlc-verify-build` (P4).
