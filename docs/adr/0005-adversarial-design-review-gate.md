# ADR: A risk-gated adversarial design-review gate at the P1→P2 boundary

**Status:** **Accepted — recommended practice (deterministic tooling deferred).**
Adopt the gate as a recommended, risk-gated P1 practice (invoke the
`adversarial-review` skill in planning mode on qualifying tickets); do **not** yet
build mechanical P2-entry enforcement into the `coldstart`/router path. Revisit the
tooling investment once trust-boundary features are built often enough that relying
on the operator to invoke it proves insufficient. Validated by the OpenCode case
study below.

**Date:** 2026-06-26 (accepted 2026-06-27)
**Deciders:** Chris Williams (with the in-session adversarial-review skill acting
as the counter-model for the case study).

> Related: the formal P5 prosecution surface ([ADR 0001](./0001-codex-native-adlc-integration.md),
> the `prosecutor` subagent in [ADR 0003](./0003-adlc-claude-code-plugin.md)) is
> the adversarial gate for *built code*. This ADR proposes the symmetric gate one
> phase earlier, for the *design*.

---

## Context

The ADLC's pre-build phases each run a deterministic or LLM-backed gate:

- **P1 Interrogate** — `parallax` (measured ambiguity), `spec-lint` (vacuous
  acceptance criteria), `premortem` (failure-first brainstorm).
- **P2 Decompose** — `coldstart` (ticket executability), `merge-forecast`,
  `model-router`.

These gates are excellent at one thing: confirming a ticket is **clear,
unambiguous, and executable without guesswork**. They were exercised in full on
ticket T1 (*Build the OpenCode integration*) and all passed.

But T1 describes a **rail-enforcement feature — a security control whose entire
purpose is to deny edits**. After the P0/P1 gates passed, an adversarial review
was run against the *planning artifacts* (the ticket and the P1 spec), asking the
single question the other gates never ask: *what is the strongest reason this
design should not be built yet?* It returned six findings the prior gates
structurally could not surface, two of them material:

1. **F1 (high) — the control is self-bypassable with no in-scope backstop.** The
   in-session hook only enforces when `ADLC_P4_ENFORCEMENT === '1'`, an
   environment variable the constrained agent itself controls. The unbypassable
   CI backstop was mentioned only in prose and was outside the ticket's declared
   `scope`.
2. **F2 (high) — the only end-to-end proof of enforcement was optional.** The
   live deny test was gated maintainer-only, so the gate could go fully green
   while a real edit-to-rail was never once demonstrated to be denied — repeating
   the "live install unverified" gap ADR 0003 had already called out.
3. **F3 (medium)** — the active-ticket selector (`ADLC_TICKET`) is an
   attacker-controlled env var, not a frozen file.
4. **F4 (medium)** — an unreconciled prevent-vs-revert mismatch between the two
   sibling precedents; whether `throw` actually aborts the write was unproven.
5. **F5 (medium)** — silent no-op (the default fail-safe) emits no signal, so a
   silently-disabled control looks identical to an active one.
6. **F6 (low)** — the ticket's `scope` could not deliver the backstop F1 requires.

The root cause is not that P1 was run poorly — it is that **none of the P1/P2
gates carry a trust-boundary lens**:

| Gate | Optimizes for | Blind to |
| --- | --- | --- |
| `parallax` | Is the request ambiguous? | Whether the converged reading is *safe* |
| `spec-lint` | Are acceptance criteria vacuous? | Whether they prove the *right* property |
| `premortem` | How might it fail? | *Who controls the control* (trust boundaries) |

A manual grounding pass against the sibling hooks fixed *fidelity* (the design now
matches their contract exactly) but **faithfully inherited their bypass surface
without questioning it**. Inheriting a weakness is not validating it. Adversarial
review is precisely the gate that questions inherited assumptions.

## Decision

Add a **risk-gated adversarial design-review gate at the P1→P2 boundary**: after
interrogation produces a concrete spec/ticket and before decomposition commits it
to the build queue, run the adversarial-review skill in *planning mode* against
the ticket and its P1 artifacts. Its findings feed a ticket revision; the gate
clears when material (high-severity) findings are resolved or explicitly accepted
with justification.

This is the mirror image of how `adversarial-review` already sits *before merge*
for code: the same skeptic, moved *before build* for high-stakes design.

### Risk gate (when it fires)

The gate is **not** run for every ticket — it needs a concrete-enough design to
attack, and it costs a model pass plus a revision cycle. It fires only when the
ticket signals a **trust boundary or safety-critical surface**, detected from the
ticket's `category` and `scope`:

- enforcement / access-control / rails / gating logic,
- authentication, authorization, secrets, or credential handling,
- data-loss or destructive operations (delete, revert, overwrite, migrate),
- supply-chain or CI/CD surface (dependencies, workflows, release),
- anything that *constrains the agent itself*.

A normal feature, refactor, or docs ticket skips the gate. T1 would have tripped
it (it is literally a deny-control).

### Mechanism

- Reuse the existing `adversarial-review` skill, Tier 3 (no diff exists yet), with
  the ticket body + P1 artifacts as the review input and an explicit instruction
  to weight trust boundaries, bypass surface, and "is this control actually
  enforcing and unbypassable".
- Output is the skill's structured verdict. `needs-attention` blocks the P1→P2
  transition until each high-severity finding is folded into the ticket (re-running
  the ticket-write protocol) or recorded as an accepted risk in the ticket body /
  the feature's ADR threat model. As a *recommended* practice the block is
  advisory-but-expected (peer to `premortem`), not a mechanical exit code — the
  accepted-risk escape hatch must be written down, not left implicit.
- **Different model required when available.** Use a different provider from the
  one that authored the spec, to avoid a self-review monoculture (the skill does
  this for code review). When only one model is available the review still runs but
  is weaker — note the degradation in the recorded verdict rather than skipping it.
- **Stopping rule (loop-until-dry).** When iterating review→revise→re-review, stop
  after a round whose findings are all refuted by the verify pass, or after two
  consecutive rounds surface no new *surviving* findings. This bounds the known
  thrash where a reviewer re-raises already-fixed findings; the `--verify` refute
  pass is what distinguishes a genuine new finding from a stale re-raise.

### Placement in the phase model

The gate is a **conditional sub-step of P1**, evaluated against the P2 entry
criteria — it does not introduce a new top-level phase. Formally: P2 decomposition
(`coldstart` et al.) may not certify a risk-gated ticket as ready until the
adversarial design review has cleared.

## Consequences

**Positive**

- Catches design-level bypass and trust-boundary defects when they cost a ticket
  edit, not a rebuild. On T1 it prevented building a clear, well-specified,
  thoroughly-tested control that was bypassable by design.
- Closes the structural blind spot in the table above without weakening the
  existing gates.
- Symmetry with P5: the ADLC now prosecutes both the design and the build.

**Negative / risks**

- Cost: an extra model pass and a revision loop. Mitigated by the risk gate —
  only safety-critical tickets pay it.
- Premature attack surface: run too early (a vague request) and there is nothing
  concrete to bite. Mitigated by placing it *after* P1 interrogation, when a
  pinned spec exists.
- Over-triggering: an over-broad risk heuristic taxes ordinary work. Mitigated by
  keeping the trigger list narrow and `category`/`scope`-driven, and by allowing
  an explicit per-ticket opt-out with justification.
- False confidence: a cleared design review is not a cleared build — P5
  prosecution of the actual code remains mandatory. This gate reduces, but does
  not remove, the need for P5.

## Alternatives considered

1. **Fold trust-boundary checks into `premortem`.** Rejected: `premortem` is a
   failure-mode brainstorm, not a trust-boundary analysis, and broadening its
   prompt dilutes both. A distinct adversarial lens with its own severity model is
   clearer and reuses the existing, battle-tested skill.
2. **Rely solely on P5 prosecution of the built code.** Rejected: this is the
   status quo, and it means trust-boundary defects are found only after the
   feature is built — exactly the expensive late-discovery the ADLC exists to
   prevent. The T1 case shows the defect was visible at the design stage.
3. **Always-on design review for every ticket.** Rejected on cost; the risk gate
   captures the high-value cases without taxing routine work.

## Validation (the OpenCode build, 2026-06-27)

The gate was exercised end-to-end while building the OpenCode integration, and it
earned its keep at both ends of the lifecycle:

- **Design phase (this gate).** The planning-phase adversarial review of ticket T1
  surfaced the bypassable-control and missing-proof findings (F1/F2 above) and the
  `.adlc/admin.pub` trust-root gap — before a line of plugin code existed. Those
  fed ticket revisions, not a rebuild.
- **Build phase (the symmetric P5-style loop).** A four-round adversarial loop on
  the *built* plugin then found five implementation defects (fail-open rail paths,
  an async-cascade bug, a hollow test) and converged cleanly under the stopping
  rule above.

Both passes used a different model (codex/GPT-5) from the author (Claude),
confirming the monoculture clause matters in practice.

## Adoption / next steps

Adopted as a **recommended practice now; deterministic tooling deferred:**

- **Now:** on a qualifying (trust-boundary / safety-critical) ticket, run the
  `adversarial-review` skill in planning mode at the P1→P2 boundary, apply the
  stopping rule, and record the cleared verdict (or accepted-risk justification) in
  the ticket body / the feature ADR's threat model for provenance.
- **Now:** reference this gate in the integration adoption docs alongside the other
  P1 gates so operators know to reach for it.
- **Deferred (revisit on ROI):** wiring the trigger heuristic into the P2 entry
  criteria (the `coldstart`/router path) so a risk-gated ticket cannot be certified
  ready until the review clears. Build this only if trust-boundary features become
  frequent enough that relying on the operator to invoke the practice proves
  insufficient.

P5 prosecution of the built code remains mandatory regardless — a cleared design
review is not a cleared build.
