---
description: Author and triage an ADLC ticket (P0) through the canonical store, then check it is executable.
---

# /adlc-ticket — author a ticket (P0 Triage)

Tickets are the contract every downstream gate reads (`coldstart`, `model-router`,
`merge-forecast`, `rails-guard`). Turn the request into a well-formed,
self-contained ticket applied through `adlc ticket`.

The request to triage: the text after the command (if empty, ask the user what
the ticket is for).

## 1. Preconditions
- Run `adlc ticket store status --json` (tell the user to run `/adlc-init` if no store exists).
- Run `adlc ticket list --json` to learn existing IDs and hashes.

## 2. Shape the ticket (executable without guesswork)
Gather: `id`, `title` (imperative), `body` (self-contained: what to build,
acceptance criteria with concrete verification commands, context), `scope` (file
globs it may touch), `rails` (frozen paths, default `[]`), `edges` (prerequisite→
dependent ordering, default `[]`), `duration` (positive number), `category`,
optional `budget`. Ask the user rather than guess if anything required is ambiguous.

## 3. Write safely (dry-run first)
Write the full proposed ticket to a temporary JSON file. Preview
`adlc ticket create --input <file> --json`; show the plan, validation, graph
effects, file operations, and hashes. Apply only after human acceptance with
`--write`. Existing-ticket changes use `adlc ticket update --expect <ticketHash>`.
Never edit the flat file or shards directly; the service owns locking, CAS,
journaling, recovery, and evidence, and never stages or commits.

Trust-root note: whenever enforcement is active (`ADLC_P4_ENFORCEMENT=1` plus
a resolved active ticket — even one declaring no rails), the active ticket
store and `.adlc/current-ticket.json` are frozen as rail trust roots. In Cursor
the `preToolUse` rail hook surfaces a **best-effort, advisory** deny for
structured edits to them (ADR-0006: Cursor's `permission: "deny"` is not
guaranteed, and shell-driven writes are not gated in-session at all); there
is no in-session bypass mechanism in this harness.
The real control is the commit-time CI rail-freeze gate
(`docs/ci/rails-guard.yml`), which rejects a PR that edits a base-frozen
trust root regardless of how the edit was made. Treat editing the ticket set
while rails are frozen as a deliberate, human-reviewed action that must land
through that gate's documented ceremony.

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
   formatter/linter flagged the ticket store, which is frozen as a rail
   trust root whenever enforcement is active (`ADLC_P4_ENFORCEMENT=1` plus an
   active ticket — see the trust-root note above), and point the user at
   `/adlc-init` step 4 (or the manual fallback) to add a permanent exclusion.
5. On pass (or no script found): continue silently.

## 5. Check executability (coldstart, keyless)
`coldstart` is LLM-backed and inside Cursor **you are the model** — no API keys.
Run `adlc coldstart <id> --prompt-only`, answer the printed audit yourself, and
report gaps (none → executable; gaps → offer to revise and re-check). To make
the verdict auditable, write your answer to a file and record it into the
manifest: `adlc coldstart <id> --prompt-only --record-verdict <file|->`.

## 6. Summarize
Report the new id, title, scope/rails, the formatter/linter check result, and
the coldstart verdict (and whether it was recorded). Point the user at
`/adlc-spec` for P1 interrogation next.
