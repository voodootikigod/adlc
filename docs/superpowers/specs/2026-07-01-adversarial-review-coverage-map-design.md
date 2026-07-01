# Design — Adversarial-review coverage map across the ADLC

**Status:** Design (brainstorming output, pending user review → writing-plans).
**Date:** 2026-07-01
**Author:** Chris Williams (@voodootikigod)
**Scope:** Documentation-only for the ADLC toolkit. Code changes to the sibling
`adversarial-review` repo are captured as follow-on tickets (see
[Implications for adversarial-review](#implications-for-adversarial-review)), not
built in this pass.

> Related: [ADR-0005](../../adr/0005-adversarial-design-review-gate.md) (P1→P2 design
> review), [ADR-0007](../../adr/0007-multimodel-adversarial-review.md) (P5 multi-model),
> [multimodel-review spec](../../specs/multimodel-review.md). This design **extends**
> both — it does not supersede them.

---

## Problem

The `adversarial-review` skill already ships a mature **loop-until-SHIP engine**:
`--loop` (`src/loop.js`) drives review → fix → re-review with a real stopping machine
(`clean` = exit 0 = SHIP, `no-progress`, `ceiling`); `--verify` is the refute pass that
separates a genuine new finding from a stale re-raise; cross-model is the *default*
inside Claude Code (detection order inverted so a non-Anthropic model reviews Claude's
output); each run is a **fresh context**; and `--providers` runs a quorum across distinct
families. The two defining properties the operator values — **cross-model** and **new
context**, looped to a **SHIP** indication — are already load-bearing in the code.

The gap is **not the engine**. It is that:

1. The ADLC deploys the engine at only **two of ~eight phases** — P1→P2 design review
   (ADR-0005) and P5 built-code review (ADR-0007) — both operator-invoked, enforcement
   deferred.
2. The `/adlc` phase router **never mentions** `adversarial-review` or `--loop`, so an
   operator reading the router would not know to reach for the engine.
3. Three high-value insertion points carry **zero coverage** (P3 rail selection, P6
   evidence recording, P1 loop protocol).

This design produces the systematic **coverage map** answering *"where does the
adversarial-review-loop add value across the ADLC"*, and formalizes the uncovered
high-value points as **recommended practice** — matching the "recommend now, defer
mechanical enforcement" posture ADR-0005 and ADR-0007 already set.

## Non-goals

- **No new deterministic `adlc` gate/tool.** Enforcement stays deferred (same trigger as
  ADR-0005/0007: revisit only when trust-boundary features are built often enough that
  operator invocation proves insufficient).
- **No mechanical P2-entry enforcement** in the `coldstart`/router path.
- **Not building** the `adversarial-review` code changes — those are follow-on tickets in
  that repo.

## The coverage map

The role of the adversarial-review-loop at each ADLC phase. The **risk gate** referenced
below is the existing trust-boundary trigger from ADR-0005/0007: auth / authorization /
trust boundary; a security control or **deny path** (rail guards, validators, sandboxes);
secrets; data-loss / destructive / irreversible ops; schema or migration; CI/CD or
supply-chain; **anything that constrains the agent itself**.

| Phase | Role | Rationale |
|---|---|---|
| **P0** Triage | **Skip** | Nothing concrete to attack yet (ADR-0005 reasoned this). |
| **P1** Interrogate | **Recommended** (design review) — ADR-0005 | + documented revision-loop protocol (this design). |
| **P2** Decompose | **Optional** | `coldstart` already gates executability; low marginal value. |
| **P3** Rail | **NEW — Recommended on the risk gate** | Attack the *rail set*, not just guard *edits*. |
| **P4** Build | **Optional** | Where `--loop` autonomous fix-until-clean actually lives; operator's call. |
| **P5** Prosecute | **Recommended; ≥2 providers required on the risk gate** — ADR-0007 | Primary home. |
| **P6** Integrate | **NEW — record the verdict as evidence** | Convergence record is what the human gate wants. |
| **P7** Distill | **Optional** | Review a distilled defense before banking it. |
| Maintenance | **Covered** | `gate-fuzzing` already plays adversary vs. the gate suite. |

## Insertion points, concretely

### 1. P3 — rail-selection review (NEW, recommended on the risk gate)

- **Fires when:** rails are being declared for a ticket that trips the risk gate.
- **Input:** not a diff — the **declared rail set + the ticket + the invariants the rails
  claim to protect** (Tier-3 planning mode today; see follow-on `--input` ticket).
- **Prompt weights three questions:** *Is every load-bearing invariant covered by a rail?
  What could break that no rail protects? Is the rail set bypassable* — via Bash (rails
  aren't gated in-session), a sibling/relative path, or an env var the agent itself
  controls? This directly generalizes ADR-0005's F1 (self-bypassable control) and F3
  (attacker-controlled selector).
- **Relationship to `rails-guard`:** complementary, not redundant. `rails-guard` checks
  **integrity** ("were frozen rails edited"). This checks **adequacy** ("are these the
  right, unbypassable rails"). A rail set can pass `rails-guard` on every commit and still
  be the wrong rails.
- **Clears when:** high-severity findings are resolved **or** accepted-with-justification,
  recorded in the ticket body / the feature ADR's threat model.

### 2. Router discoverability (NEW)

- Edit the **adlc phase router `SKILL.md`** — which is replicated **per harness** at
  `plugins/adlc-claude-code/skills/adlc/SKILL.md`, `plugins/adlc-pi/skills/adlc/SKILL.md`,
  and `plugins/adlc-codex/skills/adlc/SKILL.md`. **All harness copies must be edited** or
  discoverability is inconsistent across harnesses. In each: reference `adversarial-review`
  at P1 (design), P3 (rail selection), and P5 (built code, multi-model), and add a short
  **"adversarial-review loop"** subsection: cross-model + fresh-context + loop-until-SHIP;
  `--verify`, `--loop`, `--providers`; **exit 0 = SHIP**.
- Mirror into the toolkit "typical flow" doc where ADR-0007's adoption note already planted
  a step 6.

### 3. P6 — verdict as gate-manifest evidence (NEW, recording convention)

- **No new tool.** The loop already emits NDJSON (`loop_start / review / fix / loop_end`);
  `loop_end.exitReason === "clean"` is the SHIP signal.
- Document the convention for `gate-manifest record adversarial-review` with evidence
  fields: **providers used, iterations, final verdict, surviving findings, accepted
  findings, exit reason**.
- A helper/automation to emit that record stays deferred (see the loop-summary follow-on).

### 4. P1 — design-loop protocol (NEW, documented only)

- The code `--loop` fixer edits **files**; it cannot drive a **spec/ticket** revision loop.
  So the P1 loop is operator/agent-driven. Formalize ADR-0005's stopping rule into a
  repeatable checklist:
  1. Tier-3 review on ticket + P1 spec (weight trust boundaries).
  2. Agent revises the ticket via the ticket-write protocol.
  3. Re-review with `--verify`.
  4. **Stop** when a round's findings are all refuted by the verify pass, **or** two
     consecutive rounds surface no new *surviving* findings.
- Explicitly distinct from the code `--loop`. Automating it is a deferred code change (see
  below).

## Artifacts this design produces (all documentation)

1. **ADR-0008 — "Adversarial-review coverage map across the ADLC."** Home for the coverage
   map table + the four insertion points as recommended practice. Extends (does not
   supersede) ADR-0005/0007; keeps the "defer mechanical enforcement" posture.
2. **Edits to the adlc phase router `SKILL.md` in every harness plugin**
   (`plugins/adlc-claude-code`, `plugins/adlc-pi`, `plugins/adlc-codex`) — insertion point 2.
3. **Edits to the toolkit / typical-flow doc** — insertion point 2 + the P6 recording
   convention (insertion point 3).
4. **This design spec** — provenance.

No code, no new `adlc` tool.

## Implications for adversarial-review

The coverage map surfaces work in the sibling `adversarial-review` repo. These are
**follow-on tickets in that repo**, not part of this docs-only ADLC pass — but they are
recorded here because the ADLC insertion points depend on them.

### A. `--input` artifact review mode — *the one code change worth scheduling*

Today the tool reviews **only** a git diff or branch (sole collector: `git-context.js`).
But P3 rail-selection and P1 design review are **not diffs** — they review a rail set / a
spec, before code exists. Without an artifact-input mode both are forced down to manual
Tier-3 `--prompt-only` hand-feeding, so the loops the coverage map recommends **cannot
actually loop** for exactly the phases where trust-boundary review pays most. A first-class
mode taking provided text/files as `{{REVIEW_INPUT}}` (with grounding re-pointed from "the
change set" to "the provided artifact") mechanizes P1 and P3. The prompt template already
exposes `{{REVIEW_INPUT}}` / `{{REVIEW_COLLECTION_GUIDANCE}}` placeholders, so this is
aligned with the existing Tier-3 design, not a bolt-on.

### B. Loop-convergence summary — *nice-to-have for P6*

Add a consolidated terminal record (e.g. `--summary-json <file>`, or enrich the `loop_end`
event) capturing: providers, passes, iterations, final verdict, exit reason, surviving
findings, accepted findings. Makes the P6 `gate-manifest record adversarial-review`
convention a one-liner instead of NDJSON-stream parsing.

### C. `--providers` / quorum is already built — *update ADR-0007*

`llm.js` implements multi-provider selection, under-satisfaction accounting, and
dedup-so-duplicates-can't-inflate-quorum (AC4–AC7); `review.js` renders `corroborated_by`.
**ADR-0007's "adoption step 2: build `--providers` (follow-on ticket)" is done.** That ADR
should be updated to reflect it (a docs correction, not code).

### D. Precedent: the code already bridges into ADLC

`findings-ledger.js` writes gating findings to `.adlc/findings.jsonl` for P7
`lesson-foundry`. The P6 gate-manifest recording (insertion point 3) is the **same pattern,
different phase** — so a P6 bridge is natural, not novel.

### E. Deferred: artifact-review *loop* (P1 automation)

A loop that drives review → agent-edits-spec → re-review would be a **second** loop
implementation (the current `--loop` is inseparably git + stash + code-fixer). Scoped
docs-only here; named so the automation path is known if wanted later.

## Acceptance criteria

Each has a concrete verification method (this spec must pass `spec-lint`).

- **AC1** — *Verify:* `grep -nE 'Status|P0|P3|P5|P6|Maintenance' docs/adr/0008-adversarial-review-coverage-map.md` confirms ADR-0008 has a status line and a coverage-map table covering P0–P7 + Maintenance (all listed phases appear).
- **AC2** — *Verify:* `grep -nE 'adequacy|integrity|rails-guard' docs/adr/0008-adversarial-review-coverage-map.md` confirms ADR-0008 names the P3 review as *adequacy* (right/unbypassable rails) explicitly distinct from `rails-guard` *integrity* (frozen rails unedited).
- **AC3** — *Verify:* `grep -rlE 'adversarial-review' plugins/adlc-claude-code/skills/adlc/SKILL.md plugins/adlc-pi/skills/adlc/SKILL.md plugins/adlc-codex/skills/adlc/SKILL.md` returns all three harness router copies, and `grep -nE 'adversarial-review|exit 0|SHIP'` on each confirms it names `adversarial-review` under P1/P3/P5 and states `exit 0 = SHIP`.
- **AC4** — *Verify:* `grep -nE 'gate-manifest record adversarial-review|exitReason|iterations' docs/toolkit.md` confirms the P6 evidence-recording convention block is present in the edited typical-flow doc.
- **AC5** — *Verify:* `grep -nE 'input|summary|providers|findings-ledger' docs/adr/0008-adversarial-review-coverage-map.md` confirms the four `adversarial-review` follow-on items (A input mode, B loop-summary, C providers-done, D findings-ledger precedent) are recorded as cross-repo follow-ons under an implications heading.
- **AC6** — *Verify:* `adlc spec-lint docs/superpowers/specs/2026-07-01-adversarial-review-coverage-map-design.md` asserts exit 0 (this spec has zero wishes).
- **AC7** — *Verify:* `grep -nE 'Accepted|done|complete' docs/adr/0007-multimodel-adversarial-review.md` near adoption step 2 confirms `--providers` no longer reads as an open follow-on.

Suppressions are denied.

## Risks

- **Over-triggering P3.** An over-broad rail-review trigger taxes ordinary tickets.
  Mitigated by reusing the *same narrow* risk gate as ADR-0005/0007 (category/scope-driven).
- **Docs drift from code.** Documenting `--providers` as done couples this spec to the
  `adversarial-review` code; AC7 + AC5(C) force the ADR-0007 correction so the two stay
  consistent.
- **False confidence.** A cleared P3 rail review is not a cleared build — P5 prosecution of
  the built code remains mandatory. ADR-0008 must state this (same caveat as ADR-0005).
