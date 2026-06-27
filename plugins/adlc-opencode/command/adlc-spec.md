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

## 1. Measure ambiguity — `parallax`
Run `adlc parallax --file <spec-or-request> --prompt-only`. Produce the N
independent readings, then the divergence analysis. Every divergence above the
threshold is an ambiguity you must resolve (ask the user or research) before
proceeding. Write the converged spec to a file.

## 2. Lint acceptance criteria — `spec-lint`
Run `adlc spec-lint <spec.md> --prompt-only` and answer the vacuousness audit:
every acceptance criterion needs a concrete, runnable verification (command, test
file, or assertion). Rewrite any vacuous criterion.

## 3. Failure-first — `premortem`
Run `adlc premortem <spec.md> --prompt-only` and answer it: list 5–10 concrete,
mechanism-specific failure causes. Fold the material ones back into the spec /
acceptance criteria.

## 4. Summarize
Report the converged spec, the resolved ambiguities, and the premortem causes you
folded in. When the spec is clean, point the user at `/adlc-approve-spec` (P1 G1)
and then `/adlc-decompose` (P2).
