---
description: Author and triage an ADLC ticket (P0) into .adlc/tickets.json, then check it is executable.
---

# /adlc-ticket — author a ticket (P0 Triage)

Tickets are the contract every downstream gate reads (`coldstart`, `model-router`,
`merge-forecast`, `rails-guard`). Turn the request into a well-formed,
self-contained ticket appended to `.adlc/tickets.json`.

The request to triage: **$ARGUMENTS** (if empty, ask the user what the ticket is for).

## 1. Preconditions
- Require `.adlc/tickets.json` (tell the user to run `/adlc-init` if missing).
- Read it to learn existing ids and pick the next free `T<n>`.

## 2. Shape the ticket (executable without guesswork)
Gather: `id`, `title` (imperative), `body` (self-contained: what to build,
acceptance criteria with concrete verification commands, context), `scope` (file
globs it may touch), `rails` (frozen paths, default `[]`), `edges` (prerequisite→
dependent ordering, default `[]`), `duration` (positive number), `category`,
optional `budget`. Ask the user rather than guess if anything required is ambiguous.

## 3. Write safely (mutually exclusive)
1. Acquire a lock: `mkdir .adlc/tickets.lock` (atomic; retry briefly, else abort).
   Always `rmdir` it on every exit path.
2. Re-read the snapshot; re-derive the next free id.
3. Build the proposed array in memory (append the ticket; add a single
   prerequisite→new edge to an existing ticket only if needed).
4. Validate in memory: required fields/types; every `edge.to` resolves; no
   duplicate id; no dependency cycle. On failure, release the lock and report.
5. Write atomically: temp file in `.adlc/`, then rename over `tickets.json`.
6. Confirm: `adlc merge-forecast --json` — if it reports a cycle/gate failure,
   restore the snapshot and report; else continue.
7. Release the lock.

## 4. Check executability (coldstart, keyless)
Run `adlc coldstart <id> --prompt-only`, answer the printed audit yourself, and
report gaps (none → executable; gaps → offer to revise and re-check).

## 5. Summarize
Report the new id, title, scope/rails, and the coldstart verdict. Point the user
at `/adlc-spec` for P1 interrogation next.
