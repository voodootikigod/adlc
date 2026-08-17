---
description: Shape and stress-test a spec (P1 Interrogate) with parallax, human interrogation, premortem, and spec-lint.
argument-hint: [ticket id or rough request]
---

# /adlc:adlc-spec — interrogate the spec (P1)

Turn a ticket or rough request into an executable spec and stress it before
decomposition. Target ticket / request: **$ARGUMENTS** (default to the active
ticket in `.adlc/current-ticket.json` if empty).

All gates here are LLM-backed; inside Claude Code **you are the model**, so use
the `--prompt-only` flow (no API key): run the gate, answer the printed prompt
yourself, apply the judgment. `parallax` and `premortem` also support
`--record-verdict <file|->` with `--prompt-only` — write your answer to a file
(or pipe it on stdin with `-`) so the verdict lands in the manifest instead of
vanishing with the session.

This is one interrogation loop (`docs/interrogation-protocol.md`), not a
linear pipeline: premortem needs a spec file to stress-test, so it cannot run
before one exists, and its questions must reach the human through the SAME
loop parallax's divergences do — not after the human is already done. The
steps below sequence around that constraint; the 3-round cap in step 3 covers
the loop as a whole, not each source separately.

## 1. Measure ambiguity — `parallax`

Resolve the target to request text first: if it names an existing ticket id,
run `adlc ticket show <id> --json` and use the ticket's `body`; otherwise
treat it as the raw request text. There is no spec file yet at this step, so
`--file` (which requires an existing file) is the wrong mode — use
`--request` with the resolved text instead.

Run `adlc parallax --request "<resolved text>" --prompt-only --record-verdict <file>`.
Produce the N independent readings, then the divergence analysis. (In a live
provider setup, `adlc parallax --request "<resolved text>" --questions-json` returns the same
divergences as structured `{questions: [{point, options}]}` instead of markdown.)

## 2. Interrogate round 1, write the draft — parallax's divergences

Run the loop from `docs/interrogation-protocol.md` against this round's
frontier (parallax's divergences plus applicable
`.adlc/lessons/interrogation-template.md` checkboxes):

1. **Check the codebase before asking each question** — a divergence the repo
   resolves is folded in without asking; only what the repo cannot answer
   reaches the human.
2. Ask the full frontier in **one `AskUserQuestion` call**: numbered, the
   recommended answer as the first option (parallax's lettered options map
   directly onto the option list).
3. Fold answers into the spec as revised prose.
4. Write the draft spec to a file under `.adlc/specs/` — premortem (step 3)
   needs this file to exist.

## 3. Failure-first, then interrogate round 2 — `premortem`'s questions

Run `adlc premortem <spec.md> --prompt-only --record-verdict <file> --ticket <id>`
and answer it: list 5–10 concrete, mechanism-specific failure causes against
the draft from step 2. `--ticket` is required — the p1 gate scopes evidence
per-ticket (P1 D4: an unbound premortem record could otherwise satisfy
another ticket's approval). Its interrogation questions become this round's frontier — run
the loop again (codebase-check first, one `AskUserQuestion` call, fold answers
into the spec), then re-run parallax on the revised spec to confirm
convergence.

Still above threshold, or new divergences opened by the rewrite? Repeat the
codebase-check → ask → fold → re-run-parallax cycle — **capped at 3 rounds
total across steps 2 and 3 combined**. Still above threshold after the cap?
Do not spin: put the surviving divergences to the human one final time as
explicit decisions, record them in the spec under an "approved assumptions"
heading, and carry the residual divergence score into the `spec-approval`
payload at Gate 1.

## 4. Lint acceptance criteria — `spec-lint`

Run `adlc spec-lint <spec.md> --prompt-only` and answer the vacuousness audit:
every acceptance criterion needs a concrete, runnable verification (command,
test file, or assertion). Rewrite any vacuous criterion — this can reopen a
question; if it does, it re-enters the step 2/3 loop rather than being
resolved unilaterally. Once it passes cleanly (no `--llm`/`--prompt-only`
needed for the deterministic check itself), record it as P1 evidence —
`--record` requires `--ticket`, same reasoning as premortem's:
`adlc spec-lint <spec.md> --record --ticket <id>`.

## 5. Summarize

Report the converged spec path, the interrogation rounds run, the resolved
divergences and any approved assumptions, and the premortem causes folded in.
When the spec is clean, point the user at `/adlc:adlc-approve-spec` (P1 Gate 1)
and then the P2 gates (`adlc coldstart` · `model-router` · `merge-forecast`).
