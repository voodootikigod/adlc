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
| P3→P4 / C13 | Is it safe to START a high-risk ticket's build in THIS session? | [`adlc build-gate`](../packages/build-gate/README.md) |
| P4 / C7 | Can diverse candidates resolve a hard failing test without breaking rails? | [`adlc consensus-fix`](./tools/consensus-fix.md) |
| P5-P6 / C14 | Did prosecution dry out, did behavior change, and can a human review the evidence? | `adlc review` (runs the model review — see [seam note](#p5-recorder-vs-reviewer-seam)), [`adlc prosecute`](./tools/prosecute.md) (records its evidence — it runs no model review itself), [`adlc behavior-diff`](./tools/behavior-diff.md), [`adlc gate-manifest`](./tools/gate-manifest.md), [`adlc hollow-test`](./tools/hollow-test.md) |
| C12 / maintenance | What must be re-prosecuted after model or repo drift? | [`adlc model-ratchet`](./tools/model-ratchet.md), [`adlc review-calibration`](./tools/review-calibration.md), [`adlc skill-rot`](./tools/skill-rot.md), [`adlc ticket-prune`](./tools/ticket-prune.md) |
| P7 | Which repeated findings should become deterministic defenses? | [`adlc lesson-foundry`](./tools/lesson-foundry.md), [`adlc rejection-mining`](./tools/rejection-mining.md) |
| Continuous calibration | Can hostile candidates defeat the gates? | [`adlc gate-fuzzing`](./tools/gate-fuzzing.md) |
| Continuous / §6 | What is the recorded token spend shape, and does it match the barbell? | [`adlc spend`](./tools/spend.md) |

## P5: recorder vs. reviewer seam

**This is a deliberate design decision, not a gap:** `adlc prosecute` makes zero model
calls. It is a P5 evidence ledger — it validates input, hashes and verifies artifact
paths, and appends normalized reviewer-produced pass records to `.adlc/manifest.jsonl`.
It never judges code itself. The actual model-judged adversarial review is a separate
tool, reachable from the dispatcher as `adlc review`, which passes its arguments
straight through to `npx adversarial-review` (or the Codex/OpenCode
multi-lens loop — see [ADR-0007](./adr/0007-multimodel-adversarial-review.md)). Run the
reviewer first, then feed its normalized output into `adlc prosecute --input` as the
evidence to record. Control flow (gating, dry-pass convergence, manifest evidence) is
code; judgment (finding bugs) is models — see the package summary in
[`packages/prosecute/README.md`](../packages/prosecute/README.md) for the full seam
statement.

## Typical flow

1. Run [`adlc preflight`](./tools/preflight.md) before spawning parallel agents so missing tools, dirty state, or
   provider problems fail before work fans out.
2. Run [`adlc spec-lint`](./tools/spec-lint.md), [`adlc premortem`](./tools/premortem.md), and optionally [`adlc parallax`](./tools/parallax.md) while shaping the work so the
   accepted spec has verifiable criteria and known divergences.
3. Use [`adlc coldstart`](./tools/coldstart.md) to check ticket executability, then [`adlc merge-forecast`](./tools/merge-forecast.md) and [`adlc model-router`](./tools/model-router.md)
   to manage fan-out width and model assignment. The router emits abstract tiers
   (`cheap` / `mid` / `frontier`); [Recommended Models by Phase](./models-by-phase.md)
   maps those tiers to concrete models per provider, including open-weight and local options.
4. During implementation, use [`adlc rails-guard`](./tools/rails-guard.md) for frozen-test and suppression controls,
   [`adlc build-gate`](../packages/build-gate/README.md) to deny starting a high-risk ticket's build in a degraded
   session, and [`adlc flail-detector`](./tools/flail-detector.md) to catch repeated error loops, scope drift, churn,
   or oversized logs.
5. For hard failing tests, use [`adlc consensus-fix`](./tools/consensus-fix.md) to fan out independent candidate repairs
   and select a gated consensus winner.
6. Before review, use [`adlc hollow-test`](./tools/hollow-test.md) to prove tests are load-bearing. Run the actual
   model-judged review with [`adlc review`](#p5-recorder-vs-reviewer-seam) (passthrough to `npx adversarial-review`), then
   record its normalized output with [`adlc prosecute`](./tools/prosecute.md) — prosecute runs no model review of its
   own, it only records that one already happened and reached two dry passes. Use [`adlc behavior-diff`](./tools/behavior-diff.md)
   and [`adlc gate-manifest`](./tools/gate-manifest.md) so behavior changes are visible and gate evidence is recorded.
   For **high-blast-radius** changes
   (trust boundary, deny path, auth, secrets, data-loss, schema/migration, CI/CD), run the
   adversarial review against **≥2 distinct-family providers** and treat a single
   provider's clean approve as advisory, not a gate-pass — different models have different
   blind spots (see [ADR-0007](./adr/0007-multimodel-adversarial-review.md)). Use
   [`adlc review-calibration`](./tools/review-calibration.md) to decide, on evidence, when one model's recall is too low to trust alone.
   For the narrow **trust-root tier** — a change whose working tree vs `<base>` (tracked
   changes incl. uncommitted, unioned with untracked files)
   touches an enforcement package (`packages/rails-guard|prosecute|gate-manifest|build-gate/`),
   a gated-artifact producer (`packages/ticket-prune|ticket-sync/`), a rails deny-path, or a
   trust-root file (`scripts/rails-guard-ci.mjs`, `docs/ci/rails-guard.yml`,
   `scripts/test/rails-guard-workflow-hashes.json`, `.adlc/tickets.json`) — cross-model
   review is no longer advisory but **GATED**: `adlc prosecute` (given `--base`) exits 2
   unless the manifest holds a `cross-model-review` **`approve`** from a provider distinct
   from the author, bound to the reviewed revision. Record it with
   `adlc prosecute record-cross-model --ticket <id> --provider <p> --author-provider <a>
   --verdict approve [--input <passes.json>]` (T39; classifier `packages/prosecute/lib/tier.mjs`).
7. After review, use [`adlc lesson-foundry`](./tools/lesson-foundry.md) and [`adlc rejection-mining`](./tools/rejection-mining.md) to convert repeated review
   findings into deterministic lint checks, skills, or spec-gap templates. Lenses
   that generalize past one site graduate out of the local `.adlc/lessons/` staging
   area into [`docs/review-lenses/`](./review-lenses/) — e.g.
   [text-scanning gates](./review-lenses/text-scanning-gates.md).
8. On a schedule or after model changes, use [`adlc model-ratchet`](./tools/model-ratchet.md), [`adlc review-calibration`](./tools/review-calibration.md),
   [`adlc skill-rot`](./tools/skill-rot.md), [`adlc ticket-prune`](./tools/ticket-prune.md), and [`adlc gate-fuzzing`](./tools/gate-fuzzing.md) to re-check assumptions that can decay over time.

## Evidence conventions

Several tools use `.adlc/` as the shared workspace for machine-readable state:

- `.adlc/tickets.json` stores ticket metadata consumed by routing, cold-start, rail, and
  merge-forecast tools.
- `.adlc/manifest.jsonl` stores append-only gate evidence through `gate-manifest`.
- `.adlc/lessons/` is the default output location for [`adlc lesson-foundry`](./tools/lesson-foundry.md).

### Recording an adversarial-review verdict (P6)

Run the review itself via `adlc review` (dispatcher passthrough to `npx
adversarial-review`) or invoke `npx adversarial-review` directly. The adversarial-review
loop emits NDJSON events (`loop_start` / `review` / `fix` /
`loop_end`); `loop_end.exitReason === "clean"` is the SHIP signal. Record the verdict as
first-class human-gate evidence. `gate-manifest record` only accepts a `--data '{json}'`
payload (there is no `--evidence 'k=v; k=v'` flag — node's strict-mode `parseArgs` throws
`ERR_PARSE_ARGS_UNKNOWN_OPTION` on it), so shape the same fields as JSON:

    adlc gate-manifest record adversarial-review \
      --data '{"providers":"<a,b>","iterations":"<n>","verdict":"<approve|needs-attention>","exitReason":"<clean|no-progress|ceiling>","surviving":"<n>","accepted":"<n>"}'

Capture: providers used, iterations, final verdict, exit reason, surviving findings, and
accepted-with-justification findings. See
[ADR-0008](./adr/0008-adversarial-review-coverage-map.md). (A helper to emit this record
directly from the loop is a deferred `adversarial-review` follow-on — the loop-convergence
summary.)

**Scope the record to what it actually covered.** The mechanical trigger
(`decideAdversarialReviewNotice` — [packages/core/lib/risk-tier.mjs](../packages/core/lib/risk-tier.mjs))
treats a matching `adversarial-review` record as satisfying ANY later risk-gated change under the
same ticket (or any change at all, if no ticket-scoped/unscoped record exists to disambiguate).
Without evidence tying a record to the paths it reviewed, a single old or unrelated review can
silently satisfy every subsequent risk-gated change forever. Pass `--files` naming the exact
risk-gated paths the review covered so the record is scoped:

    adlc gate-manifest record adversarial-review --ticket <id> \
      --files 'secrets/api-key.pem,.github/workflows/deploy.yml' \
      --data '{"providers":"<a,b>","verdict":"approve","exitReason":"clean"}'

An entry with no `--files` recorded still counts under ticket-scoping alone (unchanged behavior,
for compatibility with existing records); an entry that DOES record `--files` must overlap the
currently gated paths to count.

A risk-gated CI wiring of this exact recording step — path-filtered to the ADR-0007 risk
tiers, running the full `--providers` quorum only on matching PRs and a cheap single-model
pass otherwise — ships as a documented, not-force-installed template at
[`ci/adversarial-review.yml`](./ci/adversarial-review.yml) (mirrors the
[`ci/adlc-maintenance.yml`](./ci/adlc-maintenance.yml) "template, not force-installed"
pattern). It also uses plain, non-loop review mode throughout — see the template's header
comment for why `--loop` is deliberately avoided (not because of
[voodootikigod/adversarial-review#9](https://github.com/voodootikigod/adversarial-review/issues/9),
which is fixed as of the pinned version, but because `--loop` is incompatible with the
`--base <ref>` branch-diff review this gate needs).

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
