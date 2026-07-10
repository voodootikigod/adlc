---
description: Record human spec approval (P1 Gate 1) before decomposition begins.
---

# /adlc-approve-spec — human spec approval (P1 G1)

Gate 1 is a human decision: "is this spec what I actually want built?" The model
cannot self-approve. This command records the human's explicit approval so
downstream phases have provenance.

Target ticket: **$ARGUMENTS** (default to `.adlc/current-ticket.json`).

## Steps
1. Show the user the converged spec and its acceptance criteria (from `/adlc-spec`).
2. Ask the user to explicitly approve, request changes, or reject. Do **not**
   proceed on silence or assume approval.
3. On approval, record P1 completion evidence to `.adlc/manifest.jsonl` for the
   ticket. P1 is recorded as the spec gates the runner's phase model recognizes
   (`spec-lint` / `premortem` — see `@adlc/runner` `requirementsForPhase('p1')`),
   plus an explicit human-approval note: append a `spec-lint` (or `premortem`)
   entry `{ type, ticket, ... }` if not already present, and record the approver
   and spec hash. When signing is unavailable, flag the entry `unsigned_fallback:
   true`. (There is no `accept --gate` flag; `adlc accept` records the P6
   acceptance packet, a different phase.)
4. On changes requested, loop back to `/adlc-spec`; on rejection, stop.

## Summarize
Report what was recorded (ticket id, gate, signed vs unsigned) and point the user
at `/adlc-decompose` (P2). Never fabricate approval — an unapproved spec must not
advance.
