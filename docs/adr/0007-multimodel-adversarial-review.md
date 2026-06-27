# ADR: Risk-tiered multi-model adversarial review

**Status:** **Accepted — recommended practice (mechanical enforcement deferred).**
(Superseded `Proposed` on 2026-06-27.) Adopt reviewer **diversity** as a risk-gated P5 practice: for
high-blast-radius changes, require an independent verdict from **≥2 distinct providers**
and treat a single provider's clean `approve` as **advisory, not a gate-pass**. Ship the
`--providers` multi-provider mode in the `adversarial-review` skill as the mechanism. Do
**not** yet build mechanical enforcement into `coldstart`/the router (defer, exactly as
[ADR-0005](./0005-adversarial-design-review-gate.md) deferred its P2-entry enforcement).
The full design is the [multi-model review spec](../specs/multimodel-review.md).

**Date:** 2026-06-27
**Deciders:** Chris Williams (with three independent models — Claude, Codex/GPT, and
Gemini — acting as the counter-models for the case study below).

> Related: [ADR-0005](./0005-adversarial-design-review-gate.md) adds an adversarial
> gate for the *design* (P1→P2); the P5 prosecution surface ([ADR-0001](./0001-codex-native-adlc-integration.md),
> the `prosecutor` subagent in [ADR-0003](./0003-adlc-claude-code-plugin.md)) is the
> adversarial gate for *built code*. This ADR is orthogonal to both: it governs **how
> many, and how diverse, the reviewing models must be** for either gate to be trusted.

---

## Context

The `adversarial-review` skill is already model-agnostic and, inside Claude Code or
Cursor, **prefers a single provider different from the builder** — a model reviewing its
own output is a weak critic. That is correct but insufficient. Its `--passes <n>` flag
samples **one** model N times: it raises recall on that model's blind spots but adds **no
provider diversity**. Nothing in the toolkit says *how many distinct providers* a review
needs, or that a single clean `approve` is not proof.

The cost of that gap is concrete and was observed directly (see Validation): different
providers have **different blind spots**, and a security-critical deny path can earn a
zero-finding approve from one strong model while a second strong model finds a
high-severity bypass in a single pass.

## Decision

### 1. Risk gate (when ≥2 distinct providers are required)

Reuse the `model-router` (D1) risk tiers. A change is **high-blast-radius** — and so
requires an independent verdict from **≥2 distinct-family providers** — when it touches
any of: authentication / authorization / **trust boundary**; a security control or
**deny path** (rail guards, validators, sandboxes); secrets handling; data-loss /
destructive / irreversible operations; schema or migration changes; CI/CD or
supply-chain config. For those changes a single provider's `approve` is **advisory**,
never a gate-pass. Everything else defaults to **single cross-model** review (today's
behavior); trivial / non-security changes may skip review entirely.

### 2. Mechanism — `adversarial-review --providers`

A new multi-provider mode, distinct from `--passes`:

- `--providers <a,b[,c]>` runs the same review prompt against each named provider
  independently (API key or local CLI; e.g. `gpt`, `gemini`, `claude`).
- **Merge + dedup** all findings into one report, keyed by `(file, line range,
  category)`; a finding raised by multiple providers is tagged with its corroborators
  (corroboration is signal — it raises confidence).
- **Quorum-aware verdict:** `needs-attention` if **any** provider returns a material
  finding at/above `--fail-on`; `approve` only if **all** selected providers approve.
  `--quorum <n>` may relax this deliberately.
- **Distinct-family auto-selection** when `--providers` is omitted but the risk tier (or
  the operator) requests multi-model: pick ≥2 providers from *different* families, never
  the builder's family twice.
- **No silent downgrade:** if fewer than the requested providers are reachable, run what
  is available and emit a loud notice that multi-provider was under-satisfied — a
  degraded run must not masquerade as a full one.

### 3. Evidence-driven escalation via `review-calibration`

Diversity should be applied where it demonstrably helps, not as blanket ceremony. Tie
the requirement to `review-calibration` (P5, "who reviews the reviewer"), which measures
a reviewer's injected-mutant recall on *this* repo: a **measured low single-model recall**
is the principled trigger for adding the second provider. This keeps the practice
honest — escalate on evidence of missed defects, not on a fixed model count.

### 4. Placement in the phase model

This is a **P5 (Prosecute)** practice for built code and applies equally to the
[ADR-0005](./0005-adversarial-design-review-gate.md) P1 design-review gate. Like
ADR-0005, adoption is by **operator invocation** (run the skill with `--providers` on
qualifying changes); mechanical enforcement in the gate path is **deferred** until the
manual practice proves insufficient.

## Consequences

**Positive.** Security-critical changes get genuinely independent scrutiny; corroborated
findings carry visible confidence; a single model's approve can no longer be mistaken for
proof; the escalation is evidence-driven via `review-calibration`.

**Negative / cost.** Each added provider is real tokens and wall-clock, and findings must
be triaged across reports. This is acceptable **only** because it is risk-gated — applied
to high-blast-radius code, not everywhere.

**Diminishing returns (explicit caveat).** Value comes from provider **diversity, not
count**: a third model from a family already represented adds little, and beyond ~2–3
distinct providers the marginal yield shows sharply diminishing returns. The Cursor case study's long
single-provider loop also shows that most late-round findings were narrow edges already
covered by the unbypassable CI backstop — multi-model is highest-value on the load-bearing
security logic, not on every diff. Do not prescribe a fixed N; prescribe *diversity on the
changes that warrant it*.

## Alternatives considered

- **Status quo (one different-from-builder provider).** Rejected for high-blast-radius
  code: the Validation shows one strong model's approve is not proof.
- **Always run N≥3 models on every change.** Rejected: cost without commensurate value on
  low-risk diffs; conflates count with diversity.
- **More `--passes` on a single model.** Rejected: raises recall on one model's blind
  spots but never crosses a provider boundary, so it cannot catch a cross-provider blind
  spot — exactly the failure mode observed.
- **Mechanical P5-entry enforcement now.** Deferred, mirroring ADR-0005: prove the manual
  practice first.

## Validation (the Cursor build, 2026-06-27)

On the ADLC Cursor rails-guard integration (PR #40 — a security control whose entire job
is to deny edits):

1. A same-model (**Claude**) P5 prosecution passed after catching one classifier bug.
2. A cross-model **Codex/GPT** `adversarial-review` loop ran **18 rounds** to a
   **zero-finding `approve`**, hardening many real in-session bypasses along the way.
3. A third model, **Gemini 3.1 Pro**, then found a **high-severity** multi-root
   relative-path rail bypass GPT had missed across all 18 rounds — and, after the fix,
   correctly flagged that the fix was *incomplete* (a path-mangling on different-depth
   roots) plus a `JSON.parse` fail-open. It converged to its own clean `approve` two
   rounds later.

A single model's clean approve was demonstrably **not proof**. The high-severity finding
surfaced **only** when an independent provider with different priors was added.
**Diversity, not count, was the load-bearing variable.**

## Adoption / next steps

1. ~~Accept this ADR (P6 human gate)~~ — **Accepted 2026-06-27.**
2. Build the `--providers` mode in the `voodootikigod/adversarial-review` repo per the
   spec's AC4–AC7 (follow-on ticket).
3. ~~Document the risk-tier policy in `docs/toolkit.md`~~ — **done** (Typical flow, step 6).
4. Revisit mechanical enforcement once trust-boundary features are built often enough
   that operator invocation proves insufficient — the same trigger ADR-0005 set.
