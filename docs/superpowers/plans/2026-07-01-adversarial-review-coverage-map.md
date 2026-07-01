# Adversarial-Review Coverage Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize where the cross-model, fresh-context adversarial-review loop adds value across the ADLC — as recommended practice, documentation only.

**Architecture:** Ship one new ADR (0008) carrying a phase-by-phase coverage map plus four concrete insertion points (P3 rail-selection, router discoverability, P6 evidence, P1 design-loop protocol); make the engine discoverable by editing the adlc phase router in all five harness plugins; document the P6 gate-manifest recording convention in the toolkit guide; and correct ADR-0007 to reflect that `--providers` is already built. No code, no new `adlc` tool.

**Tech Stack:** Markdown docs only. Verification is `adlc spec-lint` + `grep` acceptance checks (this is a docs change; the "tests" are the spec's ACs).

## Global Constraints

- **Documentation-only.** No source code, no new `adlc` gate/tool, no mechanical enforcement. (Design spec: Non-goals.)
- **Extends, does not supersede** ADR-0005 and ADR-0007. Keep the "recommend now, defer mechanical enforcement" posture.
- **Risk gate wording is fixed** (copy verbatim where used): auth / authorization / trust boundary; a security control or deny path (rail guards, validators, sandboxes); secrets; data-loss / destructive / irreversible ops; schema or migration; CI/CD or supply-chain; anything that constrains the agent itself.
- **Source of truth:** `docs/superpowers/specs/2026-07-01-adversarial-review-coverage-map-design.md`. Every task traces to an AC in that spec.
- **`exit 0 = SHIP`** is the canonical phrasing for the approve verdict.
- The adlc phase router is **replicated across five harness plugins in three file conventions** — every router edit must touch all five.

---

### Task 1: ADR-0008 — the coverage map

**Files:**
- Create: `docs/adr/0008-adversarial-review-coverage-map.md`

**Interfaces:**
- Consumes: the design spec (`docs/superpowers/specs/2026-07-01-adversarial-review-coverage-map-design.md`) and its Non-goals, coverage-map table, four insertion points, and Implications section.
- Produces: the filename `docs/adr/0008-adversarial-review-coverage-map.md` that Task 3 (routers) and Task 4 (toolkit) will link to. Satisfies AC1, AC2, AC5.

- [ ] **Step 1: Write the ADR file with a Status line, the coverage-map table, the P3 adequacy-vs-integrity distinction, and the four adversarial-review follow-on items.**

Create `docs/adr/0008-adversarial-review-coverage-map.md` containing (adapt prose from the spec, but these exact strings must be present for the ACs):

```markdown
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

### Insertion point: P3 rail-selection review

Fires when rails are declared for a risk-gated ticket. Reviews the declared rail set + the
ticket + the invariants the rails claim to protect, weighting: is every load-bearing
invariant covered by a rail? what could break that no rail protects? is the rail set
bypassable (Bash, a sibling/relative path, an agent-controlled env var)?

This checks **adequacy** ("are these the right, unbypassable rails") and is explicitly
distinct from `rails-guard`, which checks **integrity** ("were frozen rails edited"). A
rail set can pass `rails-guard` on every commit and still be the wrong rails.

A cleared P3 rail review is not a cleared build — P5 prosecution of the built code remains
mandatory.

### Insertion point: router discoverability, P6 evidence, P1 design-loop protocol

(Summarize the remaining three insertion points from the design spec, §"Insertion points".)

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
```

- [ ] **Step 2: Verify AC1 (status line + coverage-map table covering all phases).**

Run: `grep -nE 'Status|P0|P3|P5|P6|Maintenance' docs/adr/0008-adversarial-review-coverage-map.md`
Expected: matches for the Status line and P0, P3, P5, P6, Maintenance rows.

- [ ] **Step 3: Verify AC2 (P3 adequacy vs. rails-guard integrity).**

Run: `grep -nE 'adequacy|integrity|rails-guard' docs/adr/0008-adversarial-review-coverage-map.md`
Expected: all three terms present in the P3 section.

- [ ] **Step 4: Verify AC5 (four follow-on items recorded as cross-repo follow-ons).**

Run: `grep -nE 'input|summary|providers|findings-ledger' docs/adr/0008-adversarial-review-coverage-map.md`
Expected: A/B/C/D items all present under the Implications heading.

- [ ] **Step 5: Commit.**

```bash
git add docs/adr/0008-adversarial-review-coverage-map.md
git commit -m "docs(adr-0008): adversarial-review coverage map across the ADLC"
```

---

### Task 2: Correct ADR-0007 (`--providers` is built)

**Files:**
- Modify: `docs/adr/0007-multimodel-adversarial-review.md:137-138`

**Interfaces:**
- Consumes: nothing.
- Produces: satisfies AC7. Removes the false "follow-on ticket" status on `--providers`.

- [ ] **Step 1: Confirm `--providers` is actually implemented before editing the ADR.**

Run: `grep -nE "Multi-provider selection|resolveProviders|args\.providers" ../adversarial-review/src/llm.js`
Expected: matches (the multi-provider selection block exists). If it does NOT match, STOP — do not mark it done; report back.

- [ ] **Step 2: Rewrite adoption step 2 to mark the build complete.**

Replace lines 137–138 of `docs/adr/0007-multimodel-adversarial-review.md`:

```markdown
2. ~~Build the `--providers` mode in the `voodootikigod/adversarial-review` repo per the
   spec's AC4–AC7 (follow-on ticket).~~ — **Done.** `--providers` (multi-provider
   selection, quorum-aware verdict, dedup, under-satisfaction accounting AC4–AC7) is
   implemented in `src/llm.js` / `src/review.js`. Remaining follow-ons tracked in
   [ADR-0008](./0008-adversarial-review-coverage-map.md): `--input` artifact mode and a
   loop-convergence summary.
```

- [ ] **Step 3: Verify AC7.**

Run: `grep -nE 'Accepted|done|complete' docs/adr/0007-multimodel-adversarial-review.md`
Expected: adoption step 2 now reads as done/complete, not an open follow-on.

- [ ] **Step 4: Commit.**

```bash
git add docs/adr/0007-multimodel-adversarial-review.md
git commit -m "docs(adr-0007): mark --providers built (superseded by ADR-0008 follow-ons)"
```

---

### Task 3: Router discoverability across all five harness plugins

**Files:**
- Modify: `plugins/adlc-claude-code/skills/adlc/SKILL.md`
- Modify: `plugins/adlc-codex/skills/adlc/SKILL.md`
- Modify: `plugins/adlc-pi/skills/adlc/SKILL.md`
- Modify: `plugins/adlc-opencode/skill/adlc.md`
- Modify: `plugins/adlc-cursor/rules/adlc.mdc`

**Interfaces:**
- Consumes: ADR-0008 filename (from Task 1) for the cross-link.
- Produces: satisfies AC3. Every router names `adversarial-review` and states `exit 0 = SHIP`.

- [ ] **Step 1: Read one router to learn its phase-map format.**

Run: `sed -n '1,80p' plugins/adlc-claude-code/skills/adlc/SKILL.md`
Note whether the phase map is a prose list (claude-code/codex/pi/opencode) or a table (cursor `rules/adlc.mdc`).

- [ ] **Step 2: Add the adversarial-review reference to each router's P1/P3/P5 rows and a short loop note.**

In each of the five files, at the P1, P3, and P5 entries, add a reference to the
`adversarial-review` loop, and add this note near the phase map (adapt to prose vs. table):

```markdown
**The adversarial-review loop.** A cross-model, fresh-context ship/no-ship review that
loops review→fix→re-review until clean (`exit 0 = SHIP`). Recommended at **P1** (design
review of the ticket/spec), **P3** (attack the declared rail *set* for adequacy — is every
invariant covered and unbypassable), and **P5** (built code; ≥2 distinct providers on the
risk gate). Flags: `--verify` (refute stale findings), `--loop` (autonomous fix loop,
working-tree only), `--providers` (multi-provider quorum). See ADR-0008
(adversarial-review coverage map) in the ADLC repo.
```

**Do not use a repo-relative link to ADR-0008 in these files** — router files ship as
installed plugins where `docs/adr/` does not exist, so a relative path won't resolve.
Reference "ADR-0008" by name (as above). For `plugins/adlc-cursor/rules/adlc.mdc`, add a
table row referencing adversarial-review at P1/P3/P5 to match that file's table shape
rather than a prose list.

- [ ] **Step 3: Verify AC3 (all five routers reference the tool).**

Run: `grep -lE 'adversarial-review' plugins/adlc-claude-code/skills/adlc/SKILL.md plugins/adlc-codex/skills/adlc/SKILL.md plugins/adlc-pi/skills/adlc/SKILL.md plugins/adlc-opencode/skill/adlc.md plugins/adlc-cursor/rules/adlc.mdc`
Expected: all five paths printed.

Run: `grep -lE 'exit 0 = SHIP' plugins/adlc-claude-code/skills/adlc/SKILL.md plugins/adlc-codex/skills/adlc/SKILL.md plugins/adlc-pi/skills/adlc/SKILL.md plugins/adlc-opencode/skill/adlc.md plugins/adlc-cursor/rules/adlc.mdc`
Expected: all five paths printed.

- [ ] **Step 4: Commit.**

```bash
git add plugins/adlc-claude-code/skills/adlc/SKILL.md plugins/adlc-codex/skills/adlc/SKILL.md plugins/adlc-pi/skills/adlc/SKILL.md plugins/adlc-opencode/skill/adlc.md plugins/adlc-cursor/rules/adlc.mdc
git commit -m "docs(routers): surface the adversarial-review loop in all 5 harness phase routers"
```

---

### Task 4: P6 gate-manifest evidence convention in the toolkit guide

**Files:**
- Modify: `docs/toolkit.md` (add to the "Evidence conventions" section, around line 48)

**Interfaces:**
- Consumes: ADR-0008 filename for the cross-link.
- Produces: satisfies AC4.

- [ ] **Step 1: Add the recording-convention block under "Evidence conventions".**

Insert into `docs/toolkit.md` in the "Evidence conventions" section:

```markdown
### Recording an adversarial-review verdict (P6)

The adversarial-review loop emits NDJSON events (`loop_start` / `review` / `fix` /
`loop_end`); `loop_end.exitReason === "clean"` is the SHIP signal. Record the verdict as
first-class human-gate evidence:

    adlc gate-manifest record adversarial-review \
      --evidence 'providers=<a,b>; iterations=<n>; verdict=<approve|needs-attention>; exitReason=<clean|no-progress|ceiling>; surviving=<n>; accepted=<n>'

Capture: providers used, iterations, final verdict, exit reason, surviving findings, and
accepted-with-justification findings. See
[ADR-0008](./adr/0008-adversarial-review-coverage-map.md). (A helper to emit this record
directly from the loop is a deferred `adversarial-review` follow-on — the loop-convergence
summary.)
```

- [ ] **Step 2: Verify AC4.**

Run: `grep -nE 'gate-manifest record adversarial-review|exitReason|iterations' docs/toolkit.md`
Expected: the convention block matches all three tokens.

- [ ] **Step 3: Commit.**

```bash
git add docs/toolkit.md
git commit -m "docs(toolkit): P6 convention for recording the adversarial-review verdict as gate evidence"
```

---

### Task 5: Full acceptance gate

**Files:** none (verification only).

**Interfaces:**
- Consumes: all prior tasks.
- Produces: green run of every AC + spec-lint (AC6).

- [ ] **Step 1: Re-run spec-lint on the design spec (AC6).**

Run: `adlc spec-lint docs/superpowers/specs/2026-07-01-adversarial-review-coverage-map-design.md`
Expected: exit 0, "all criteria verified."

- [ ] **Step 2: Run every AC verification command in sequence.**

Run each verify command from the spec's Acceptance criteria (AC1–AC7) and confirm each
matches as described in Tasks 1–4.
Expected: all pass.

- [ ] **Step 3: Optional dogfood — re-review the branch with the loop.**

Run: `node ../adversarial-review/bin/cli.js --base main --provider agy --verify`
Expected: `APPROVE` (exit 0). If NEEDS-ATTENTION with a *grounded* surviving finding,
manually verify it (do not blind-trust either verdict), fix, and re-review until SHIP.

- [ ] **Step 4: Final commit if any fixes were applied in Step 3; otherwise done.**

```bash
git add -A && git commit -m "docs(adlc): address final adversarial-review findings" || echo "nothing to commit"
```
