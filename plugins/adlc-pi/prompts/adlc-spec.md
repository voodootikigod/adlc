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

## 1. Measure ambiguity — `parallax`
Run `adlc parallax --file <spec-or-request> --record-verdict <file>` (add
`--prompt-only` to answer it yourself). Produce the N independent readings, then
the divergence analysis. Every divergence above the threshold is an ambiguity you
must resolve (ask the user or research) before proceeding. Write the converged
spec to a file under `.adlc/specs/`.

## 2. Lint acceptance criteria — `spec-lint`
Run `adlc spec-lint <spec.md> --json` (or `--prompt-only`) and answer the
vacuousness audit: every acceptance criterion needs a concrete, runnable
verification (command, test file, or assertion). Rewrite any vacuous criterion.

## 3. Failure-first — `premortem`
Run `adlc premortem <spec.md> --record-verdict <file>` (add `--prompt-only` to
answer it yourself) and produce 5–10 concrete, mechanism-specific failure causes.
Fold the material ones back into the spec / acceptance criteria.

## 4. Summarize
Report the converged spec, the resolved ambiguities, and the premortem causes you
folded in. When the spec is clean, point the user at `/adlc-approve-spec` (P1 G1)
and then `/adlc-decompose` (P2).
