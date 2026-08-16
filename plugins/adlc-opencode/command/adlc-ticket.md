---
description: Author and triage an ADLC ticket (P0) through the canonical store, then check it is executable.
---

# /adlc-ticket — author a ticket (P0 Triage)

Tickets are the contract every downstream gate reads (`coldstart`, `model-router`,
`merge-forecast`, `rails-guard`). Turn the request into a well-formed,
self-contained ticket applied through `adlc ticket`.

The request to triage: **$ARGUMENTS** (if empty, ask the user what the ticket is for).

## 1. Preconditions
- Run `adlc ticket store status --json` (tell the user to run `/adlc-init` if no store exists).
- Run `adlc ticket list --json` to learn existing IDs and hashes.

## 2. Shape the ticket (executable without guesswork)
Gather: `id`, `title` (imperative), `body` (self-contained: what to build,
acceptance criteria with concrete verification commands, context), `scope` (file
globs it may touch), `rails` (frozen paths, default `[]`), `edges` (prerequisite→
dependent ordering, default `[]`), `duration` (positive number), `category`,
optional `budget`. Before the dry-run, interrogate the human per the shared
protocol (`docs/interrogation-protocol.md` in the ADLC repo): frontier rounds of
numbered questions with a recommended answer first, **codebase-checked before
asking** (only what the repo cannot answer reaches the human; applicable
`.adlc/lessons/interrogation-template.md` checkboxes are mandatory candidates),
answers folded into the body as revised prose, stopping when the frontier is
empty (5-round cap with approved assumptions otherwise).

## 3. Write safely (dry-run first)
Write the full proposed ticket to a temporary JSON file. Preview
`adlc ticket create --input <file> --json`; show the plan, validation, graph
effects, file operations, and hashes. Apply only after human acceptance with
`--write`. Existing-ticket changes use `adlc ticket update --expect <ticketHash>`.
Never edit the flat file or shards directly; the service owns locking, CAS,
journaling, recovery, and evidence, and never stages or commits.

## 4. Warn (don't fail) if the repo's formatter/linter would reformat the write
The write in step 3 just changed the canonical ticket store on disk. If the repo's
formatter/linter isn't excluding `.adlc/` (see `/adlc-init` step 4), this file
can silently red the next PR. Check now, non-blocking:
1. Read `package.json`'s `scripts.check`, else `scripts.lint`. Neither present →
   skip silently.
2. Detect the package manager from the lockfile (`pnpm-lock.yaml` → pnpm,
   `yarn.lock` → yarn, `bun.lockb` → bun, else npm).
3. Run the check scoped to `.adlc/` if the underlying tool supports a path arg
   (biome/eslint/prettier); otherwise run the full script.
4. On failure: do not undo the write or fail the command — warn that the
   formatter/linter flagged the ticket store, which becomes a frozen trust
   root once a ticket declares `rails`, and point the user at `/adlc-init`
   step 4 (or the manual fallback) to add a permanent exclusion.
5. On pass (or no script found): continue silently.

## 5. Check executability (coldstart, keyless)
Run `adlc coldstart <id> --prompt-only` and answer the printed audit yourself.
Gaps found → the post-write interrogation loop (`docs/interrogation-protocol.md`):
codebase-check each gap, ask the human the rest, fold answers into the body via
`adlc ticket update <id> --input <file> --expect <ticketHash> --write`, re-check
until the gap list is empty (5-round cap; `--expect` takes the **current**
hash — capture the `ticketHash` each update prints, a stale one fails the
CAS). No gaps → executable. The p0 assertion re-checks the ticket's CURRENT
hash (a ticket edited after coldstart ran must re-run it), so record the hash
it audited: get it with `adlc ticket show <id> --json` (the `ticketHash`
field), write `{"gaps":[],"ticketHash":"<that hash>"}`, then
`adlc coldstart <id> --prompt-only --record-verdict <file|->`.

`adlc-runner run p0` requires `--ticket <id>` — p0 is ticket-scoped, not a
global presence check.

## 6. Summarize
Report the new id, title, scope/rails, the formatter/linter check result, and
the coldstart verdict. Point the user at `/adlc-spec` for P1 interrogation next.
