---
name: adlc-spec
description: Run ADLC P0-P2 specification, interrogation, ticket decomposition, cold-start, merge forecast, and model routing workflows in Codex.
---

ADLC_CODEX_SENTINEL_SPEC_V1

# ADLC Spec

Drive P0-P2 with executable acceptance criteria.

## P0 — Author a ticket

Tickets are the contract every downstream ADLC tool reads (`coldstart`,
`model-router`, `merge-forecast`, `rails-guard`). Turn a request into a
well-formed, self-contained ticket through the canonical ticket store
service — never by hand-editing `.adlc/tickets.json` or shard files.

### Preconditions

- `adlc ticket store status --json` — confirm a store exists. If not, run
  `$adlc-init` first; do not silently create the workspace here.
- `adlc ticket list --json` — inspect existing ids/hashes. If the interactive
  command offers legacy migration, show the plan and honor the human's
  answer; declining continues on legacy storage.

### Shape the ticket

A ticket must be **executable without guesswork** — exactly what `coldstart`
checks. Gather or infer:

- **id** — the next free `T<n>`; must be unique in the store.
- **title** — one line, imperative.
- **body** — full, self-contained: what to build, acceptance criteria with
  concrete verification methods, and any context an agent needs. Do not
  assume the agent can see prior conversation.
- **scope** — file globs this ticket may touch.
- **rails** — frozen paths that must NOT change during the build; declaring
  rails here is what later arms rail-guard enforcement. Default `[]`.
- **edges** — ordering constraints, direction **prerequisite → dependent**:
  an edge `{ "to": "TX", "contract": "..." }` lives on the *prerequisite*
  ticket and means that ticket must complete before `TX`. If existing
  tickets depend on the new one, add `{ "to": "<existing id>" }` edges to the
  *new* ticket. If the new ticket depends on an existing prerequisite `T0`,
  the edge lives on `T0`, not the new ticket. Default `[]`.
- **duration**, **category**, **budget** — as needed; `duration` defaults to
  `1` if unknown.

If anything required for a self-contained ticket is ambiguous, ask rather
than guess — a vague ticket fails `coldstart`.

### Apply the change through the store service (atomic, locked, evidenced)

Write the proposed full ticket document to a temporary JSON file outside the
tracked store. Preview with `adlc ticket create --input <file> --json`
(dry-run by default) — review the plan, validation, graph effects, file
operations, and after-hash. Only once accepted, re-run with `--write`. Use
`adlc ticket update <id> --input <file> --expect <ticketHash> --write` for
edits to an existing ticket; a **scope-widening** or **rail-narrowing** edit
requires `--authorize` and becomes evidence-required (an audited, deliberate
change, not something to do casually). The service owns locking, full-graph
validation, compare-and-swap, journaling, and recovery — if it reports
`RECOVERY_REQUIRED`, stop and ask the human to choose
`adlc ticket store recover --complete` or `--rollback`. Never hand-edit the
store file, and never stage or commit the result yourself.

### Formatter/linter check (non-blocking)

The atomic write just changed a tracked file. If the repo's formatter/linter
is not excluding `.adlc/` (see `$adlc-init`), this can silently red the next
PR. Check for a `scripts.check` or `scripts.lint` entry in `package.json`;
run it scoped to the ticket file if the tool supports a path argument,
otherwise the full script. A failure here does **not** undo the write — warn
the human plainly and point them at `$adlc-init`'s formatter-exclusion step.

### Check executability (coldstart gate)

`coldstart` is LLM-backed; inside Codex you are the model, so use the
prompt-only path — never the bare form, which needs an API key and exits `1`
without one:

1. `adlc coldstart <id> --prompt-only` — prints the executability-audit
   prompt and exits `0` without calling any provider.
2. Answer that prompt yourself, applying its own rubric: list every genuine
   gap that would block a fresh agent (information not derivable from the
   repo).
3. No gaps → the ticket is executable, done. Gaps found → summarize and offer
   to revise the ticket body/scope, then re-check.

## P1-P2 commands

```sh
adlc parallax --request "<request>"
adlc spec-lint spec.md --json
adlc premortem spec.md --json
adlc coldstart --all --tickets .adlc/tickets.json --json
adlc merge-forecast --tickets .adlc/tickets.json --json
adlc model-router --tickets .adlc/tickets.json --json
```

Stop for human approval after P1 spec approval. Do not mark P2 complete until the ticket
DAG and cold-start checks pass.
