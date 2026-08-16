---
description: Record human spec approval (P1 Gate 1) before decomposition begins.
---

# /adlc-approve-spec — human spec approval (P1 G1)

Gate 1 is a human decision: "is this spec what I actually want built?" The model
cannot self-approve. This command records the human's explicit approval so
downstream phases have provenance.

Target ticket: the text after the command (default to `.adlc/current-ticket.json`).

## Steps
1. Show the user the converged spec and its acceptance criteria (from `/adlc-spec`).
2. Ask the user to explicitly approve, request changes, or reject. Do **not**
   proceed on silence or assume approval.
3. On approval, record the evidence with the interrogation summary from the
   `/adlc-spec` run — the p1 gate assertion validates this payload: it rejects
   `unresolved != 0` (a divergence the human chose not to resolve belongs in
   `approved_assumptions`, not the unresolved count), requires exactly one
   bound ticket and spec file, checks `spec_hash` against the file's actual
   hash at record time and against its CURRENT content (catches a fabricated
   hash or a post-approval edit), and requires the approval to postdate the
   latest `spec-lint`/`premortem` evidence:
   `adlc gate-manifest record spec-approval --ticket <id> --files <spec path> --data
   '{"approver":"<who>","spec_hash":"<sha256 of the spec file>","verdict":"approved",
   "rounds":<n>,"questions":<n>,"sources":["coldstart","parallax","premortem"],
   "unresolved":0,"approved_assumptions":[]}'`.
   (There is no runner verb for P1 approval — `adlc-runner accept` is the P6
   acceptance-packet recorder and takes `--packet`, not `--gate`.)
4. On changes requested, loop back to `/adlc-spec`; on rejection, **record
   nothing** and stop — never record a `spec-approval` entry with a
   non-`"approved"` verdict.

## Summarize
Report what was recorded (ticket id, gate, signed vs unsigned) and point the user
at `/adlc-decompose` (P2). Never fabricate approval — an unapproved spec must not
advance.
