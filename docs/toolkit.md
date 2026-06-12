# ADLC Toolkit Guide

ADLC treats agentic development as a lifecycle with explicit gates. The tools in this
repository are small CLIs that make those gates concrete: they inspect specs and tickets,
route work to models, protect rails, compare behavior, record evidence, and convert
review findings into reusable defenses.

## Lifecycle map

| Phase | Question | Primary tools |
| --- | --- | --- |
| D2 Phase 0 | Is the workspace ready for fan-out? | `preflight` |
| P1 / C1-C2 | Is the spec testable and stress-tested? | `spec-lint`, `premortem`, `parallax` |
| P2 / C3 | Can an agent execute this ticket without guessing? | `coldstart`, `merge-forecast`, `model-router` |
| P3-P4 / C5-C6 | Are frozen rails protected, and is an agent flailing? | `rails-guard`, `flail-detector` |
| P4 / C7 | Can diverse candidates resolve a hard failing test without breaking rails? | `consensus-fix` |
| P5-P6 / C14 | Did behavior change, and can a human review the evidence? | `behavior-diff`, `gate-manifest`, `hollow-test` |
| C12 / maintenance | What must be re-prosecuted after model or repo drift? | `model-ratchet`, `review-calibration`, `skill-rot` |
| P7 | Which repeated findings should become deterministic defenses? | `lesson-foundry`, `rejection-mining` |
| Continuous calibration | Can hostile candidates defeat the gates? | `gate-fuzzing` |

## Typical flow

1. Run `preflight` before spawning parallel agents so missing tools, dirty state, or
   provider problems fail before work fans out.
2. Run `spec-lint`, `premortem`, and optionally `parallax` while shaping the work so the
   accepted spec has verifiable criteria and known divergences.
3. Use `coldstart` to check ticket executability, then `merge-forecast` and `model-router`
   to manage fan-out width and model assignment.
4. During implementation, use `rails-guard` for frozen-test and suppression controls and
   `flail-detector` to catch repeated error loops, scope drift, churn, or oversized logs.
5. For hard failing tests, use `consensus-fix` to fan out independent candidate repairs
   and select a gated consensus winner.
6. Before review, use `hollow-test`, `behavior-diff`, and `gate-manifest` to prove that
   tests are load-bearing, behavior changes are visible, and gate evidence is recorded.
7. After review, use `lesson-foundry` and `rejection-mining` to convert repeated review
   findings into deterministic lint checks, skills, or spec-gap templates.
8. On a schedule or after model changes, use `model-ratchet`, `review-calibration`,
   `skill-rot`, and `gate-fuzzing` to re-check assumptions that can decay over time.

## Evidence conventions

Several tools use `.adlc/` as the shared workspace for machine-readable state:

- `.adlc/tickets.json` stores ticket metadata consumed by routing, cold-start, rail, and
  merge-forecast tools.
- `.adlc/manifest.jsonl` stores append-only gate evidence through `gate-manifest`.
- `.adlc/lessons/` is the default output location for `lesson-foundry`.

The package READMEs define each tool's exact schema. Treat these docs as a routing map,
then follow the linked README for command-specific details.

## Exit-code convention

The CLIs generally follow the same gate shape:

- `0` means the gate passed or the command completed successfully.
- `2` means the gate found a material issue that should block or be reviewed.
- `1` means the command could not complete, such as bad input, missing files, or provider
  configuration failure.

Always check an individual package README before wiring a CI gate, because some tools have
mode-specific behavior.
