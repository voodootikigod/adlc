# The Interrogation Protocol (P0/P1)

> The doctrine (`ADLC.md`, P1): *"Grillme-style interrogation: ask me questions
> until you have none left, but check the codebase before asking each one."*
> This document defines that loop once, normatively, so every harness plugin
> references it instead of drifting. Spec:
> `.adlc/specs/p0-p1-human-interrogation.md`.

Interrogation is how a spec or ticket moves from *what the author had in their
head* to *what a fresh agent can execute without guessing*. The enemy is
underspecification, not sampling randomness: at temperature zero, a vague spec
still yields confidently wrong code. The interrogator's job is to empty the
space of silent assumptions **before** the store write (P0) or the spec
approval (P1) — minutes here replace hours of diff review later.

## The design tree and the frontier

Track the open decisions of the work as a tree: each node is a decision, and a
child is a decision that only makes sense once its parent is settled ("which
serializer?" is a child of "do we persist at all?").

The **frontier** is the set of decisions whose prerequisites are all settled.
Each round of interrogation:

1. Puts **every** frontier question to the human at once — numbered, each with
   a recommended answer stated first. Never drip one question at a time; never
   ask a question whose premise depends on an unanswered earlier question.
2. Folds the answers in (see *Transcript handling*), which settles nodes and
   exposes their children — the new frontier.
3. Repeats.

The human decides; the interrogator discovers. Facts about the environment —
what a file contains, which package owns a behavior, what a tool's flag does —
are never questions for the human. Research them.

## The codebase-check clause

Before any question reaches the human, attempt to answer it from the
repository. Only questions the repo **cannot** answer may be asked. This is the
half of the doctrine that matters: it is what distinguishes interrogation from
a questionnaire, and it is why generic checklists ("what are the edge cases?")
are not interrogation. A question the repo already answers, asked anyway, is a
defect in the interrogator.

## Question sources, in priority order

Consume these in order; earlier sources outrank later ones because they carry
evidence, not intuition:

1. **coldstart gaps** — `adlc coldstart <id> --prompt-only` emits
   `{gaps: [{what, why_blocking}]}`: the audited list of exactly what would
   force a fresh agent to ask a human. Each gap becomes one frontier question.
   Timing: coldstart takes a **persisted** ticket id — there is no draft
   input — so this source is available only once the ticket exists in the
   store. In P0 the pre-write rounds run from the field checklist and the
   design tree (sources 4–5); coldstart gaps drive the **post-write** rounds,
   which loop until the gap list is empty and end with
   `adlc coldstart <id> --prompt-only --record-verdict -`. In P1 the ticket
   already exists, so coldstart gaps are available from the first round.
2. **parallax divergences** — `adlc parallax` fans out independent readings
   and renders the points where they split, already shaped as lettered
   multiple-choice. Each divergence becomes one frontier question.
3. **premortem interrogation questions** — `adlc premortem` outputs one
   question per postulated failure cause ("Questions to fold into
   interrogation"). Fold them into the frontier. Timing: premortem stress-tests
   a written spec, so it cannot run before one exists — run it after the first
   interrogation round has produced a draft, and route its questions through a
   further round of this same loop rather than resolving them unilaterally
   after the human is already done. Recording: `--record-verdict` requires
   `--ticket <id>` — a P1 gate that scopes spec-lint/premortem evidence by
   ticket cannot see an unbound record, and an unbound one could otherwise
   satisfy a *different* ticket's approval.
4. **`.adlc/lessons/interrogation-template.md`** — when present, the P7
   lesson miner's recurring spec-gap checklist. Every checkbox that applies to
   the work at hand is a mandatory frontier **candidate** — it must be
   consumed, but it still passes through the codebase-check clause like any
   other question: if the repo answers it, fold the answer into the artifact
   as a spec statement without asking; only what the repo cannot answer
   reaches the human. This is how the decay loop's findings reach the next
   spec instead of dead-ending.
5. **The interrogator's own frontier** — everything else the design tree
   surfaces that the repo cannot answer.

## Stopping condition

The loop ends when the frontier is empty: every branch of the design tree
visited, nothing left silently assumed. Then give the human a one-screen
readback of every resolved decision and get an explicit confirmation of shared
understanding. Only after that confirmation does the flow proceed — to the
store write in P0, or toward Gate 1 approval in P1.

The loop is also bounded when the frontier refuses to empty: **5 rounds
maximum** in any interrogation mode (P0 or P1). Hitting the cap triggers the
same escape hatch as the parallax cap below — put the surviving questions to
the human one final time as explicit decisions, record what they choose not to
resolve as approved assumptions in the artifact, and proceed. Each round is
human-paced (the human can always stop early), so the cap exists to bound the
model-driven side: re-runs of gap generators must not be able to spawn new
questions forever.

## The parallax re-run cap

In P1, answers are folded into the spec and parallax re-runs to measure whether
ambiguity actually dropped. This loop is capped at **3 rounds**. If divergence
is still above threshold after the cap, do not spin: put the surviving
divergences to the human one final time as explicit decisions, record them in
the spec as **approved assumptions**, and proceed to Gate 1 with the residual
divergence score carried in the `spec-approval` payload. A bounded loop with an
audited escape hatch beats an unbounded one that drains budget on a stubbornly
ambiguous trade-off.

## Transcript handling

Resolved question→answer pairs are folded into the ticket body or spec text
itself — **never** a sidecar file, never left in conversation history. Two
reasons:

- Re-runs of `coldstart`, `parallax`, and `spec-lint` must see the answers,
  or they will re-raise settled questions.
- A fresh downstream agent sees only the artifact. Answers folded in are spec;
  answers anywhere else are lost.

Fold answers as revised prose (rewrite the ambiguous sentence), not as an
appended Q&A log. Approved assumptions from the parallax cap are the one
exception: list them explicitly under an "approved assumptions" heading so the
human gate can see what was assumed rather than resolved.

## Harness bindings

- **Claude Code** — ask via `AskUserQuestion`: one call per round, numbered
  questions, the recommended answer as the first option.
- **Other harnesses** (Cursor, OpenCode, Codex, Copilot, pi) — use the
  harness-native prompt affordance with the same round discipline.
- **Headless / CI** — interrogation is skipped; the gates instead check that
  the answers are already folded into the artifact. This is why the transcript
  rule above is load-bearing: a headless `coldstart` or `spec-lint` run can
  only pass on an artifact whose interrogation already happened.
