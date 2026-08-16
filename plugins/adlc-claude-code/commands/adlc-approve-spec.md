---
description: Record human spec approval (P1 Gate 1) with its interrogation summary before decomposition begins.
argument-hint: [ticket id]
---

# /adlc:adlc-approve-spec — human spec approval (P1 G1)

Gate 1 is a human decision: "is this spec what I actually want built?" The
model cannot self-approve. This command records the human's explicit approval —
with the interrogation evidence behind it — so downstream phases have
provenance. The p1 gate assertion (`adlc-runner run p1`) requires this record
and validates its payload.

Target ticket: **$ARGUMENTS** (default to `.adlc/current-ticket.json`).

## Steps

1. Show the user the converged spec and its acceptance criteria (from
   `/adlc:adlc-spec`), including any "approved assumptions" section.
2. Ask the user to explicitly approve, request changes, or reject — via
   `AskUserQuestion`, with the three outcomes as options. Do **not** proceed on
   silence or assume approval.
3. On approval, record the evidence with the interrogation summary from the
   `/adlc:adlc-spec` run:

   ```
   adlc gate-manifest record spec-approval --ticket <id> --files <spec path> --data '{
     "approver": "<who>",
     "spec_hash": "<sha256 of the spec file>",
     "verdict": "approved",
     "rounds": <interrogation rounds run>,
     "questions": <questions asked>,
     "sources": ["coldstart", "parallax", "premortem", "interrogation-template"],
     "unresolved": 0,
     "approved_assumptions": ["<each divergence approved under the round cap>"],
     "residual_divergence": <last parallax score, if any rounds hit the cap>
   }'
   ```

   `sources` lists only the question sources actually consumed. `unresolved`
   must be `0` — the gate rejects anything else; a divergence the human chose
   not to resolve belongs in `approved_assumptions`, not in the unresolved
   count. `--ticket <id>` and `--files <spec path>` are both required: the p1
   assertion rejects an approval that is not bound to exactly one ticket and
   exactly one spec file, checks that `spec_hash` matches the file's actual
   hash at record time (catches a fabricated hash), checks that the spec
   file's CURRENT content still matches (catches editing the spec after
   approval), and requires the approval to be recorded after the latest
   `spec-lint`/`premortem` evidence (catches approving a pre-audit draft).
   (There is no runner verb for P1 approval — `adlc-runner accept` is
   the P6 acceptance-packet recorder and takes `--packet`, not `--gate`.)
4. On changes requested, loop back to `/adlc:adlc-spec`; on rejection, **record
   nothing** and stop — do not record a `spec-approval` entry with
   `"verdict":"rejected"` or any other non-`"approved"` value; the gate
   rejects it either way, and a stray rejected record is confusing evidence to
   leave in the manifest.

## Summarize

Report what was recorded (ticket id, gate, rounds/questions/sources, any
approved assumptions, signed vs unsigned) and point the user at the P2 gates
(`adlc coldstart` · `model-router` · `merge-forecast`). Never fabricate
approval — an unapproved spec must not advance.
