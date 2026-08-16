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

Before the dry-run, interrogate the human per the shared protocol
(`docs/interrogation-protocol.md` in the ADLC repo): frontier rounds of
numbered questions with a recommended answer first, **codebase-checked before
asking** (only what the repo cannot answer reaches the human; applicable
`.adlc/lessons/interrogation-template.md` checkboxes are mandatory
candidates), answers folded into the body as revised prose, stopping when the
frontier is empty (5-round cap with approved assumptions otherwise). A ticket
built on silent assumptions fails `coldstart`.

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
3. Act on the verdict — the post-write half of the interrogation loop
   (`docs/interrogation-protocol.md`): gaps found → codebase-check each gap,
   ask the human the rest, fold answers into the body via
   `adlc ticket update <id> --input <file> --expect <ticketHash> --write`,
   re-check until the gap list is empty (5-round cap; `--expect` takes the
   **current** hash — capture the `ticketHash` each update prints, a stale
   one fails the CAS). No gaps → executable. The p0 assertion re-checks the
   ticket's CURRENT hash (a ticket edited after coldstart ran must re-run
   it), so record the hash it audited: get it with `adlc ticket show <id>
   --json` (the `ticketHash` field), write
   `{"gaps":[],"ticketHash":"<that hash>"}`, then
   `adlc coldstart <id> --prompt-only --record-verdict <file|->`.

`adlc-runner run p0` requires `--ticket <id>` — p0 is ticket-scoped, not a
global presence check.

## P1-P2 commands

P1's parallax divergences are frontier questions — resolve them via the shared
interrogation protocol (`docs/interrogation-protocol.md` in the ADLC repo):
codebase-check each one, ask the human the rest in numbered rounds with a
recommended answer first, fold answers into the spec, and re-run parallax —
capped at 3 rounds, after which surviving divergences are recorded as approved
assumptions in the spec. `adlc parallax --questions-json` returns the
divergences as structured `{questions: [{point, options}]}` for this loop.

`premortem` needs a written spec to stress-test, so it runs only after the
first interrogation round has produced one — never before, and never as a
step whose questions get silently resolved by the model. Its output feeds a
SECOND round of the same loop (codebase-check, ask the human, fold answers,
re-run parallax) before spec-lint; the 3-round cap covers both rounds
combined, not each source separately. Both `premortem --record-verdict` and
`spec-lint --record` require `--ticket <id>` — the p1 gate scopes evidence
per-ticket (P1 D4: an unbound record could otherwise satisfy another
ticket's approval).

```sh
adlc parallax --request "<request>"
# … interrogation round 1, write the draft spec …
adlc premortem spec.md --prompt-only --record-verdict <file> --ticket <id>
# … interrogation round 2 on premortem's questions …
adlc spec-lint spec.md --prompt-only  # answer the vacuousness audit
adlc spec-lint spec.md --record --ticket <id>  # once it passes cleanly
adlc coldstart --all --tickets .adlc/tickets.json --json
adlc merge-forecast --tickets .adlc/tickets.json --json
adlc model-router --tickets .adlc/tickets.json --json
```

Stop for human approval after P1 spec approval. Do not mark P2 complete until the ticket
DAG and cold-start checks pass.
