# ADR: Adversarial-review coverage map across the ADLC

**Status:** Accepted — recommended practice (mechanical enforcement deferred).
**Date:** 2026-07-01
**Deciders:** Chris Williams (with agy/Gemini as the cross-model reviewer for the dogfood loop below).

> Extends (does not supersede) [ADR-0005](./0005-adversarial-design-review-gate.md) (P1→P2
> design review) and [ADR-0007](./0007-multimodel-adversarial-review.md) (P5 multi-model).

## Context

The `adversarial-review` skill already ships a mature loop-until-SHIP engine (`--loop`,
`--verify`, cross-model default inside Claude Code, fresh context per run, `--providers`
quorum). The gap is deployment: the ADLC wired it into only P1→P2 and P5, and the `/adlc`
phase router never points at it. This ADR maps its role across every phase and formalizes
the high-value uncovered points as recommended practice.

## Decision — the coverage map

The risk gate below is the trust-boundary trigger from ADR-0005/0007: auth / authorization
/ trust boundary; a security control or deny path (rail guards, validators, sandboxes);
secrets; data-loss / destructive / irreversible ops; schema or migration; CI/CD or
supply-chain; anything that constrains the agent itself.

| Phase | Role | Rationale |
|---|---|---|
| P0 Triage | Skip | Nothing concrete to attack yet. |
| P1 Interrogate | Recommended (design review) — ADR-0005 | + documented revision-loop protocol. |
| P2 Decompose | Optional | `coldstart` already gates executability. |
| P3 Rail | NEW — Recommended on the risk gate | Attack the rail *set*, not just guard *edits*. |
| P4 Build | Optional | Where `--loop` autonomous fix-until-clean lives. |
| P5 Prosecute | Recommended; ≥2 providers on the risk gate — ADR-0007 | Primary home. |
| P6 Integrate | NEW — record the verdict as evidence | Convergence record is what the human gate wants. |
| P7 Distill | Optional | Review a distilled defense before banking it. |
| Maintenance | Covered | `gate-fuzzing` already plays adversary vs. the gate suite. |

## Insertion points, concretely

### 1. P3 rail-selection review (NEW, recommended on the risk gate)

Fires when rails are declared for a risk-gated ticket. Reviews the declared rail set + the
ticket + the invariants the rails claim to protect, weighting: is every load-bearing
invariant covered by a rail? what could break that no rail protects? is the rail set
bypassable (Bash, a sibling/relative path, an agent-controlled env var)? This directly
generalizes ADR-0005's F1 (self-bypassable control) and F3 (attacker-controlled selector).

This checks **adequacy** ("are these the right, unbypassable rails") and is explicitly
distinct from `rails-guard`, which checks **integrity** ("were frozen rails edited"). A
rail set can pass `rails-guard` on every commit and still be the wrong rails. The review
clears when high-severity findings are resolved or accepted-with-justification, recorded in
the ticket body / the feature ADR's threat model.

A cleared P3 rail review is not a cleared build — P5 prosecution of the built code remains
mandatory.

### 2. Router discoverability (NEW)

The `/adlc` phase router is replicated across five harness plugins with three different
file conventions — `plugins/adlc-claude-code/skills/adlc/SKILL.md`,
`plugins/adlc-codex/skills/adlc/SKILL.md`, `plugins/adlc-pi/skills/adlc/SKILL.md`,
`plugins/adlc-opencode/skill/adlc.md` (singular `skill/`, lowercase `adlc.md`), and
`plugins/adlc-cursor/rules/adlc.mdc` (Cursor's `.mdc` rules format, table-shaped router) —
all five must be edited or discoverability is inconsistent across harnesses. Each router
should reference `adversarial-review` at P1 (design), P3 (rail selection), and P5 (built
code, multi-model), and add a short "adversarial-review loop" note covering: cross-model +
fresh-context + loop-until-SHIP; `--verify`, `--loop`, `--providers`; **exit 0 = SHIP**
(adapted to each router's existing shape — prose list vs. Cursor's table). The same
discoverability note should be mirrored into the toolkit "typical flow" doc, where ADR-0007's
adoption note already planted a step 6.

### 3. P6 verdict as gate-manifest evidence (NEW, recording convention)

No new tool is required — the loop already emits NDJSON (`loop_start` / `review` / `fix` /
`loop_end`), and `loop_end.exitReason === "clean"` is the SHIP signal. This point documents
the convention for `gate-manifest record adversarial-review`, with evidence fields:
providers used, iterations, final verdict, surviving findings, accepted findings, and exit
reason. A helper/automation to emit that record as a one-liner stays deferred (see the
loop-convergence-summary follow-on below); today it means parsing the NDJSON stream by hand.

### 4. P1 design-loop protocol (NEW, documented only)

The code `--loop` fixer edits files; it cannot drive a spec/ticket revision loop, so the P1
loop is operator/agent-driven. This formalizes ADR-0005's stopping rule into a repeatable
checklist: (1) Tier-3 review on the ticket + P1 spec, weighting trust boundaries; (2) the
agent revises the ticket via the ticket-write protocol; (3) re-review with `--verify`; (4)
stop when a round's findings are all refuted by the verify pass, or two consecutive rounds
surface no new surviving findings. This is explicitly distinct from the code `--loop` —
automating an artifact-review loop for P1 is a deferred code change, not built here.

## Implications for adversarial-review (cross-repo follow-ons, not ADLC deliverables)

- **A. `--input` artifact review mode** — the one code change worth scheduling; without it
  the P1/P3 loops cannot actually loop (the tool reviews only a git diff today).
- **B. Loop-convergence summary** — a consolidated terminal record for P6 evidence.
- **C. `--providers` is already built** in `llm.js`/`review.js` (AC4–AC7 of the
  multimodel-review spec) — ADR-0007's adoption step 2 must be corrected.
- **D. `findings-ledger`** already bridges review findings to `.adlc/findings.jsonl` for
  P7 lesson-foundry — precedent for the P6 gate-manifest bridge.

## Validation (dogfood, 2026-07-01)

The design spec for this ADR was itself run through a driven `adversarial-review` loop
(reviewer: agy/Gemini, `--base main --verify`). It converged in three rounds and, en route,
caught a real per-harness router-replication defect (wrong path + two omitted harnesses)
that the deterministic gate alone would have shipped.
