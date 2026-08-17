---
description: Shape and stress-test a spec (P1 Interrogate) with parallax, spec-lint, and premortem.
argument-hint: "[ticket-or-request]"
---

# /adlc-spec — interrogate the spec (P1)

Turn a ticket or rough request into an executable spec and stress it before
decomposition. Target ticket / request: `$ARGUMENTS` (default to the active
ticket in `.adlc/current-ticket.json` when empty).

These gates are LLM-backed. In pi you drive a configured model, so you can run
each gate against your provider (`--json`) or answer it yourself with
`--prompt-only` (keyless — you are the working model). `parallax` and `premortem`
also support `--record-verdict <file|->` so the verdict lands in
`.adlc/manifest.jsonl` instead of vanishing with the session. See the `adlc-spec`
skill for the full command reference.

This is one interrogation loop (`docs/interrogation-protocol.md`), not a
linear pipeline: premortem needs a spec file to stress-test, so it cannot run
before one exists, and its questions must reach the human through the SAME
loop parallax's divergences do — never folded back unilaterally. The steps
below sequence around that constraint; the 3-round cap covers the loop as a
whole, not each source separately.

## 1. Measure ambiguity — `parallax`
Resolve the target to request text first: if it names an existing ticket id,
run `adlc ticket show <id> --json` and use the ticket's `body`; otherwise
treat it as the raw request text. There is no spec file yet at this step, so
`--file` (which requires an existing file) is the wrong mode — use
`--request` with the resolved text instead.

Run `adlc parallax --request "<resolved text>" --prompt-only --record-verdict <file>`
and answer it yourself. `--prompt-only` is required alongside
`--record-verdict`, not optional — the CLI errors otherwise (keyless
operation; recording without it is undefined). Produce the N independent
readings, then the divergence analysis.

## 2. Interrogate round 1, write the draft — parallax's divergences
Every divergence above the threshold is an ambiguity you must resolve via the
shared interrogation protocol (`docs/interrogation-protocol.md` in the ADLC
repo): codebase-check each one, ask the human the rest in numbered frontier
rounds with a recommended answer first, fold answers into the spec. Write the
draft spec to a file under `.adlc/specs/` — premortem (step 3) needs this
file to exist.

## 3. Failure-first, then interrogate round 2 — `premortem`'s questions
Run `adlc premortem <spec.md> --prompt-only --record-verdict <file> --ticket <id>`
and answer it yourself — `--prompt-only` is required alongside
`--record-verdict`; without it the record branch never runs and nothing is
recorded, even on a live provider call. `--ticket` is also required — the p1
gate scopes evidence per-ticket, and `/adlc-approve-spec` reads this recorded
entry to prove interrogation actually happened before it will open its
confirm dialog. Produce 5–10 concrete, mechanism-specific failure causes
against the draft from step 2. Its interrogation questions become this
round's frontier — run the loop again (codebase-check first, ask the human
the rest, fold answers into the spec), then re-run parallax to confirm
convergence.

Still above threshold, or new divergences opened by the rewrite? Repeat the
codebase-check → ask → fold → re-run-parallax cycle — **capped at 3 rounds
total across steps 2 and 3 combined**. Still above threshold after the cap?
Record the surviving divergences in the spec as approved assumptions.

## 4. Lint acceptance criteria — `spec-lint`
Run `adlc spec-lint <spec.md> --json` (or `--prompt-only`) and answer the
vacuousness audit: every acceptance criterion needs a concrete, runnable
verification (command, test file, or assertion). Once it passes cleanly,
record it as P1 evidence: `adlc spec-lint <spec.md> --record --ticket <id>`
(`--record` requires `--ticket`, same reasoning as premortem's). Rewrite any
vacuous criterion — this can reopen a question; if it does, it re-enters the
step 2/3 loop rather than being resolved unilaterally.

## 5. Summarize
Report the converged spec, the resolved ambiguities, and the premortem causes you
folded in. When the spec is clean, point the user at `/adlc-approve-spec` (P1 G1)
and then `/adlc-decompose` (P2).
