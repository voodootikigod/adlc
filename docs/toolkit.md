# ADLC Toolkit Guide

ADLC treats agentic development as a lifecycle with explicit gates. The tools in this
repository are small CLIs that make those gates concrete: they inspect specs and tickets,
route work to models, protect rails, compare behavior, record evidence, and convert
review findings into reusable defenses. User-facing workflows should invoke these tools
through the stable `adlc <tool>` dispatcher.

## Lifecycle map

| Phase | Question | Primary tools |
| --- | --- | --- |
| D2 Phase 0 | Is the workspace ready for fan-out? | [`adlc preflight`](./tools/preflight.md) |
| P1 / C1-C2 | Is the spec testable and stress-tested? | [`adlc spec-lint`](./tools/spec-lint.md), [`adlc premortem`](./tools/premortem.md), [`adlc parallax`](./tools/parallax.md) |
| P2 / C3 | Can an agent execute this ticket without guessing? | [`adlc coldstart`](./tools/coldstart.md), [`adlc merge-forecast`](./tools/merge-forecast.md), [`adlc model-router`](./tools/model-router.md) |
| P3-P4 / C5-C6 | Are frozen rails protected, and is an agent flailing? | [`adlc rails-guard`](./tools/rails-guard.md), [`adlc flail-detector`](./tools/flail-detector.md) |
| P4 / C7 | Can diverse candidates resolve a hard failing test without breaking rails? | [`adlc consensus-fix`](./tools/consensus-fix.md) |
| P5-P6 / C14 | Did prosecution dry out, did behavior change, and can a human review the evidence? | [`adlc prosecute`](./tools/prosecute.md), [`adlc behavior-diff`](./tools/behavior-diff.md), [`adlc gate-manifest`](./tools/gate-manifest.md), [`adlc hollow-test`](./tools/hollow-test.md) |
| C12 / maintenance | What must be re-prosecuted after model or repo drift? | [`adlc model-ratchet`](./tools/model-ratchet.md), [`adlc review-calibration`](./tools/review-calibration.md), [`adlc skill-rot`](./tools/skill-rot.md) |
| P7 | Which repeated findings should become deterministic defenses? | [`adlc lesson-foundry`](./tools/lesson-foundry.md), [`adlc rejection-mining`](./tools/rejection-mining.md) |
| Continuous calibration | Can hostile candidates defeat the gates? | [`adlc gate-fuzzing`](./tools/gate-fuzzing.md) |

## Typical flow

1. Run [`adlc preflight`](./tools/preflight.md) before spawning parallel agents so missing tools, dirty state, or
   provider problems fail before work fans out.
2. Run [`adlc spec-lint`](./tools/spec-lint.md), [`adlc premortem`](./tools/premortem.md), and optionally [`adlc parallax`](./tools/parallax.md) while shaping the work so the
   accepted spec has verifiable criteria and known divergences.
3. Use [`adlc coldstart`](./tools/coldstart.md) to check ticket executability, then [`adlc merge-forecast`](./tools/merge-forecast.md) and [`adlc model-router`](./tools/model-router.md)
   to manage fan-out width and model assignment.
4. During implementation, use [`adlc rails-guard`](./tools/rails-guard.md) for frozen-test and suppression controls and
   [`adlc flail-detector`](./tools/flail-detector.md) to catch repeated error loops, scope drift, churn, or oversized logs.
5. For hard failing tests, use [`adlc consensus-fix`](./tools/consensus-fix.md) to fan out independent candidate repairs
   and select a gated consensus winner.
6. Before review, use [`adlc hollow-test`](./tools/hollow-test.md), [`adlc prosecute`](./tools/prosecute.md), [`adlc behavior-diff`](./tools/behavior-diff.md), and [`adlc gate-manifest`](./tools/gate-manifest.md)
   to prove that tests are load-bearing, prosecution reached two dry passes, behavior
   changes are visible, and gate evidence is recorded. For **high-blast-radius** changes
   (trust boundary, deny path, auth, secrets, data-loss, schema/migration, CI/CD), run the
   adversarial review against **≥2 distinct-family providers** and treat a single
   provider's clean approve as advisory, not a gate-pass — different models have different
   blind spots (see [ADR-0007](./adr/0007-multimodel-adversarial-review.md)). Use
   [`adlc review-calibration`](./tools/review-calibration.md) to decide, on evidence, when one model's recall is too low to trust alone.
7. After review, use [`adlc lesson-foundry`](./tools/lesson-foundry.md) and [`adlc rejection-mining`](./tools/rejection-mining.md) to convert repeated review
   findings into deterministic lint checks, skills, or spec-gap templates.
8. On a schedule or after model changes, use [`adlc model-ratchet`](./tools/model-ratchet.md), [`adlc review-calibration`](./tools/review-calibration.md),
   [`adlc skill-rot`](./tools/skill-rot.md), and [`adlc gate-fuzzing`](./tools/gate-fuzzing.md) to re-check assumptions that can decay over time.

## Evidence conventions

Several tools use `.adlc/` as the shared workspace for machine-readable state:

- `.adlc/tickets.json` stores ticket metadata consumed by routing, cold-start, rail, and
  merge-forecast tools.
- `.adlc/manifest.jsonl` stores append-only gate evidence through `gate-manifest`.
- `.adlc/lessons/` is the default output location for [`adlc lesson-foundry`](./tools/lesson-foundry.md).

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
