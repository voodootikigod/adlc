---
description: Shape and stress-test a spec (P1 Interrogate) with parallax, spec-lint, and premortem.
---

# /adlc-spec — interrogate the spec (P1)

Turn a ticket or rough request into an executable spec and stress it before
decomposition. Target ticket / request: the text after the command (default to
the active ticket in `.adlc/current-ticket.json` if empty).

All gates here are LLM-backed; inside Cursor *you are the model*, so use the
`--prompt-only` flow (no API key): run the gate, answer the printed prompt
yourself, apply the judgment. `parallax` and `premortem` also support
`--record-verdict <file|->` with `--prompt-only` — write your answer to a file
(or pipe it on stdin with `-`) so the verdict lands in `.adlc/manifest.jsonl`
instead of vanishing with the session.

## 1. Measure ambiguity — `parallax`
Run `adlc parallax --file <spec-or-request> --prompt-only --record-verdict <file>`.
Produce the N independent readings, then the divergence analysis. Every
divergence is a frontier question — resolve it via the shared interrogation
protocol (`docs/interrogation-protocol.md` in the ADLC repo): codebase-check
each one, ask the human the rest in numbered rounds with a recommended answer
first, fold answers into the spec as revised prose, and re-run parallax —
**capped at 3 rounds**, after which surviving divergences are recorded in the
spec as approved assumptions and the residual score is carried into the
`spec-approval` payload. (With a live provider, `--questions-json` returns the
divergences as structured `{questions: [{point, options}]}`.) Write the
converged spec to a file under `.adlc/specs/`.

## 2. Lint acceptance criteria — `spec-lint`
Run `adlc spec-lint <spec.md> --prompt-only` and answer the vacuousness audit:
every acceptance criterion needs a concrete, runnable verification (command, test
file, or assertion). Rewrite any vacuous criterion.

## 3. Failure-first — `premortem`
Run `adlc premortem <spec.md> --prompt-only --record-verdict <file>` and answer
it: list 5–10 concrete, mechanism-specific failure causes. Fold the material
ones back into the spec / acceptance criteria.

## 4. Summarize
Report the converged spec, the resolved ambiguities, and the premortem causes you
folded in. When the spec is clean, point the user at `/adlc-approve-spec` (P1 G1)
and then `/adlc-decompose` (P2).
