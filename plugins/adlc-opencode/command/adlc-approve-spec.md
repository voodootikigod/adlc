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
3. On approval, record the evidence via the runner:
   `adlc-runner accept --ticket <id> --gate p1` (or, if the runner is unavailable,
   append an unsigned `spec_approval` entry to `.adlc/manifest.jsonl` noting the
   approver and the spec hash, flagged `unsigned_fallback: true`).
4. On changes requested, loop back to `/adlc-spec`; on rejection, stop.

## Summarize
Report what was recorded (ticket id, gate, signed vs unsigned) and point the user
at `/adlc-decompose` (P2). Never fabricate approval — an unapproved spec must not
advance.
