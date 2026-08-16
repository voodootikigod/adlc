---
description: Shape and stress-test a spec (P1 Interrogate) with parallax, human interrogation, spec-lint, and premortem.
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

## 1. Measure ambiguity — `parallax`

Run `adlc parallax --file <spec-or-request> --prompt-only --record-verdict <file>`.
Produce the N independent readings, then the divergence analysis. (In a live
provider setup, `adlc parallax --file <spec> --questions-json` returns the same
divergences as structured `{questions: [{point, options}]}` instead of markdown.)

## 2. Interrogate the human

Every divergence is a frontier question; so are premortem's questions once step
4 runs, and applicable `.adlc/lessons/interrogation-template.md` checkboxes.
Run the loop from `docs/interrogation-protocol.md`:

1. **Check the codebase before asking each question** — a divergence the repo
   resolves is folded in without asking; only what the repo cannot answer
   reaches the human.
2. Ask each round's full frontier in **one `AskUserQuestion` call**: numbered,
   the recommended answer as the first option (parallax's lettered options map
   directly onto the option list).
3. Fold answers into the spec as revised prose and re-run parallax on the
   revised spec — **capped at 3 rounds**. Still above threshold after the cap?
   Do not spin: put the surviving divergences to the human one final time as
   explicit decisions, record them in the spec under an "approved assumptions"
   heading, and carry the residual divergence score into the `spec-approval`
   payload at Gate 1.
4. Write the converged spec to a file under `.adlc/specs/`.

## 3. Lint acceptance criteria — `spec-lint`

Run `adlc spec-lint <spec.md> --prompt-only` and answer the vacuousness audit:
every acceptance criterion needs a concrete, runnable verification (command,
test file, or assertion). Rewrite any vacuous criterion.

## 4. Failure-first — `premortem`

Run `adlc premortem <spec.md> --prompt-only --record-verdict <file>` and answer
it: list 5–10 concrete, mechanism-specific failure causes. Its interrogation
questions join the step-2 frontier; fold the material ones back into the spec /
acceptance criteria.

## 5. Summarize

Report the converged spec path, the interrogation rounds run, the resolved
divergences and any approved assumptions, and the premortem causes folded in.
When the spec is clean, point the user at `/adlc:adlc-approve-spec` (P1 Gate 1)
and then the P2 gates (`adlc coldstart` · `model-router` · `merge-forecast`).
