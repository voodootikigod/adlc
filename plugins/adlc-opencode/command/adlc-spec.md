---
description: Shape and stress-test a spec (P1 Interrogate) with parallax, spec-lint, and premortem.
---

# /adlc-spec — interrogate the spec (P1)

Turn a ticket or rough request into an executable spec and stress it before
decomposition. Target ticket / request: **$ARGUMENTS** (default to the active
ticket in `.adlc/current-ticket.json` if empty).

All gates are LLM-backed; inside OpenCode *you are the model*, so use the
`--prompt-only` flow (no API key): run the gate, answer the printed prompt
yourself, apply the judgment.

This is one interrogation loop (`docs/interrogation-protocol.md`), not a
linear pipeline: premortem needs a spec file to stress-test, so it cannot run
before one exists, and its questions must reach the human through the SAME
loop parallax's divergences do — never folded back unilaterally by the model.
The steps below sequence around that constraint; the 3-round cap covers the
loop as a whole, not each source separately.

## 1. Measure ambiguity — `parallax`
Resolve the target to request text first: if it names an existing ticket id,
run `adlc ticket show <id> --json` and use the ticket's `body`; otherwise
treat it as the raw request text. There is no spec file yet at this step, so
`--file` (which requires an existing file) is the wrong mode — use
`--request` with the resolved text instead.

Run `adlc parallax --request "<resolved text>" --prompt-only`. Produce the N
independent readings, then the divergence analysis.

## 2. Interrogate round 1, write the draft — parallax's divergences
Every divergence is a frontier question — resolve it via the shared
interrogation protocol (`docs/interrogation-protocol.md` in the ADLC repo):
codebase-check each one, ask the human the rest in numbered rounds with a
recommended answer first, fold answers into the spec as revised prose. Write
the draft spec to a file — premortem (step 3) needs this file to exist.

## 3. Failure-first, then interrogate round 2 — `premortem`'s questions
Run `adlc premortem <spec.md> --prompt-only --record-verdict <file> --ticket <id>`
and answer it: list 5–10 concrete, mechanism-specific failure causes against
the draft from step 2. `--ticket` is required — the p1 gate scopes evidence
per-ticket (an unbound record could otherwise satisfy another ticket's
approval).
Its interrogation questions become this round's frontier — run the loop
again (codebase-check first, ask the human the rest, fold answers into the
spec), then re-run parallax to confirm convergence.

Still above threshold, or new divergences opened by the rewrite? Repeat the
codebase-check → ask → fold → re-run-parallax cycle — **capped at 3 rounds
total across steps 2 and 3 combined**. Still above threshold after the cap?
Record the surviving divergences in the spec as approved assumptions and
carry the residual score into the `spec-approval` payload. (With a live
provider, `--questions-json` returns divergences as structured
`{questions: [{point, options}]}`.)

## 4. Lint acceptance criteria — `spec-lint`
Run `adlc spec-lint <spec.md> --prompt-only` and answer the vacuousness audit:
every acceptance criterion needs a concrete, runnable verification (command, test
file, or assertion). Once it passes cleanly, record it as P1 evidence —
`adlc spec-lint <spec.md> --record --ticket <id>`. Rewrite any vacuous criterion — this can reopen a
question; if it does, it re-enters the step 2/3 loop rather than being
resolved unilaterally.

## 5. Summarize
Report the converged spec, the resolved ambiguities, and the premortem causes you
folded in. When the spec is clean, point the user at `/adlc-approve-spec` (P1 G1)
and then `/adlc-decompose` (P2).
