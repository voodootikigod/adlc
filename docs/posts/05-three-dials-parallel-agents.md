---
title: "Three Dials: Parallel Agents Without Merge Hell"
series: "The Agentic Development Lifecycle"
part: 5
date: 2026-06-11
description: "Cost, wall-clock, accuracy — the three dials of multi-agent orchestration, why they're coupled, why '3–5 agents' keeps showing up in field reports, and how to measure ambiguity instead of asking the model about it."
---

# Three Dials: Parallel Agents Without Merge Hell

The series so far has built one reliable lane: spec interrogated ([post 2](./02-two-human-gates.md)), rails frozen ([post 3](./03-tests-are-the-spec.md)), build prosecuted until dry ([post 4](./04-prosecution-not-code-review.md)). This post is about running several lanes at once — which is where most multi-agent setups quietly catch fire.

Parallel development has exactly three dials — **cost** (which models), **wall-clock** (how wide to fan out), and **accuracy** (context and contract quality) — and the central fact about them is that they are not independent. Parallelism trades cost for wall-clock *at constant accuracy only when the partition is clean*. With a bad partition, it trades cost for **negative** accuracy: contract drift, merge hell, integration bugs that surface days later. So the orchestration problem is, underneath, a partitioning problem, and most of this post is about making partition quality measurable *before* you pay for the fan-out.

## First decision: lanes, not a boss agent

The most common orchestration architecture is also the worst one: a frontier model "deciding what to do next." A model-as-scheduler is the most expensive, least reproducible scheduler ever built, and its context rots like any other (F3) — by hour three it's scheduling based on a stale mental model of work it dispatched in hour one.

The rule: **control flow is code; judgment is models.** The orchestrator is a deterministic script — loops, DAG scheduling, gate checks — that *spawns* models where judgment is needed and never consults one about sequencing.

```
              ┌─────────────────────────────────────────┐
              │ ORCHESTRATOR — deterministic script      │
              │ (no model; topological scheduler)        │
              └──┬──────────┬──────────┬──────────┬──────┘
                 │          │          │          │
        ┌────────▼───┐ ┌────▼─────┐ ┌──▼────────┐ ┌▼──────────────┐
        │ CONTRACT   │ │ BUILDER  │ │PROSECUTION│ │ INTEGRATOR    │
        │ DESK       │ │ POOL     │ │POOL       │ │ LANE          │
        │ frontier;  │ │ tier per │ │ shared;   │ │ cheap+determ.;│
        │ pins DAG-  │ │ ticket;  │ │ fresh ctx;│ │ sequential    │
        │ edge       │ │ 1 writer │ │ calibrated│ │ merge/rebase  │
        │ contracts  │ │ per      │ │           │ │ pipeline      │
        │            │ │ partition│ │           │ │               │
        └────────────┘ └──────────┘ └───────────┘ └───────────────┘
```

Notes on the lanes:

- **Prosecutors are pooled, not paired with builders.** The fresh-context requirement (E4) means a prosecutor gains nothing from familiarity with "its" builder — dedicated pairing just buys idle time.
- **Builders are single-writer per partition.** Parallel *construction* on shared state produces merge hell; parallel *search* (bug hunting, design alternatives) is where parallelism is nearly free (E1). Most multi-agent disasters come from confusing these two — applying search-parallelism to a construction problem and paying for it in coordination noise.
- **The integrator lane is sequential by necessity** — merges serialize. It is the system's bottleneck, and that turns out to determine everything about fan-out width.
- **The contract desk gets the frontier model, always.** Why becomes clear below.

## The cost dial: route by escape cost, by ladder, and by float

Post 2 introduced the principle — model tier is a function of the cost of *detecting* an error, not of task prestige. Made mechanical, it has three parts.

**Route by rail density.** For each ticket, compute how much of its output is deterministically checked: test coverage over its declared file scope, type strictness, contract tests on its DAG edges. High rail density → errors are caught instantly and regeneration is cheap → the cheapest model that clears the gates is correct. Low rail density (contracts, migrations, anything uncovered) → errors are expensive to find → frontier. The routing quantity is *expected cost of an escaped error* — probability an error survives all gates, times blast radius.

**Escalation ladders, not static assignment.** Start cheap; on gate failure, *regenerate* one tier up with the failure appended to the ticket as known-dead-ends. Never continue the failed context at the higher tier — escalation is regeneration, not rescue (F8). Toy math: a cheap model at 0.1 cost-units with 60% first-pass rate, a mid model at 1.0 with 90% — the ladder expects ≈0.55 units versus 1.0 for always-mid, a ~45% cut. The ladder costs latency on the failures, though, which produces the one genuinely non-obvious routing rule:

**Route by DAG float.** Critical-path method, applied to model selection. Every ticket has *float* — slack before it blocks anything downstream. Tickets **on the critical path** skip the ladder and go straight to the highest-first-pass tier, because a retry there delays the entire delivery. Tickets **with float greater than expected retry latency** ride the ladder, because their retries are absorbed by slack and cost nothing in wall-clock. Same ticket content, different correct model — *position in the graph*, not prestige of the work, decides.

And the priors come from records, not vibes: every gate in the lifecycle logs model × ticket-category × first-pass outcome into the merge's evidence manifest. That ledger *is* the routing table — per-repo, empirical, self-tuning. `npx model-router` reads the ticket (scope, DAG position, rail density) plus the manifest history and emits `{model, mode: ladder|direct, budget}`. Its exit-2 case is worth savoring: a ticket whose rail density is below the floor for *any* cheap tier isn't a routing problem — it's an under-railed ticket wearing a routing costume, and that's worth knowing before spending either way.

## The wall-clock dial: forecast conflicts, derive the width

**The schedule is a DAG, not a list.** Decomposition's output is tickets plus edges, every edge carrying an explicit contract. Scheduling is then topological: all ready nodes run concurrently, and *completion events* — not phase barriers — trigger the next dispatch. Barrier waves ("finish all of phase 2, then start phase 3") waste exactly the idle time the slowest ticket imposes on the fastest.

**Predict conflicts; don't resolve them.** Two parallel tickets that touch the same file were never parallel — they were a merge conflict scheduled in advance. Conflict probability per ticket *pair* is computable before any agent runs, from four signals:

1. **Declared file-scope overlap** — hard veto; overlapping scopes serialize, no model needed.
2. **Import-graph radius** — A writes files B's scope imports → elevated risk; pin the shared interface first.
3. **Historical co-change coupling** — files that co-commit frequently are logically coupled even when the import graph says otherwise. Mined once from git history, refreshed each cycle.
4. **Namespace collisions** — the class file analysis can't see: two branches with *zero shared files* that still break the merged build. Route-segment conflicts (Next.js forbids `[pk]` and `[voteKey]` at the same path level), duplicate exported symbol names, colliding migration sequence numbers. Field-verified failure mode: the scope overlap was clean, and the merge still burned hours. Forecast these by diffing declared *namespaces* — routes, exports, migration ids — not just declared files.

`npx merge-forecast` runs all four, validates the DAG, computes per-ticket float (feeding `model-router`), and emits a dispatch schedule plus a width recommendation. Exit 2 = partition unsafe at the requested width, offending pairs named. Seconds, before any build token is spent. This is the measurement the post opened with: **fan-out width should never exceed what the conflict forecast certifies.**

**Why "3–5 agents" keeps showing up.** Practitioners keep reporting the same magic width, and it isn't mystical. Merges serialize: merge, rebase survivors, re-green, next. If builds complete faster than the integrator absorbs them, the queue grows and rebase costs compound with every open worktree. Steady-state width is therefore

> width ≈ mean ticket build time ÷ mean merge-rebase-regreen time

Twenty-minute builds over four-minute integrations ≈ width 5. The folklore number is this ratio for typical ticket sizes, observed without being derived. Corollary worth more than the formula: you raise useful width by making *integration* faster — build caching, cheap re-green suites, smaller rebase surfaces — not by spawning more builders into a queue.

**Speculative execution — and "pinned" means merged.** Dependency edges don't have to serialize *work*, only *truth*. But field experience sharpens what "pinned contract" must mean: a contract floating in a plan doc is not pinned. A contract is pinned when the **foundation is built first and merged to main** — schema, shared types, query functions — *before* the fan-out, with those foundation paths auto-appended to every parallel ticket's frozen rails. Builders consume the foundation; they never reinterpret it. (Read the actual query function before writing consumer code; never guess property names.) With the foundation merged, downstream tickets build against it *while* upstream features build in parallel — exactly like issuing instructions against a register promise. If upstream must break the contract, downstream regenerates, and regeneration is cheap (E5). This recovers most of the parallelism the DAG appears to forbid — and it's why the contract desk gets the frontier model: **contract stability is what makes the whole speculative schedule solvent.**

## The accuracy dial: measure ambiguity, don't introspect it

The interrogation phase (post 2) has a structural weakness it shares with every "ask me clarifying questions" pattern: it asks the model to know what it doesn't know — the exact metacognition LLMs are worst at. One interrogator in one rotting context, question quality unmeasured, fired once at the start, and blind to the place parallel accuracy actually dies: the *edges between tickets*.

`npx parallax` replaces introspection with **measurement**, using the same property that powers everything else in this lifecycle (E1 — sampling diversity as an instrument):

1. **Fan:** give the raw request to N cheap agents in fresh contexts (3–5): *"write the spec you would execute."* No questions allowed — force each to commit to a reading.
2. **Diff the readings.** Where all N agree, the request is demonstrably unambiguous — ask the human *nothing* there. Where they diverge, that divergence is a *measured* ambiguity, pre-shaped as a question: **"Your request has three live readings: A, B, C. Which did you mean?"**
3. **Fold and re-fan** until divergence drops below threshold.
4. **Exit on convergence, not confidence.** The residual divergence is a number — the spec's ambiguity score — and downstream gates can gate on it.

Every question is provably load-bearing (it exists only because it changes what would be built). Multiple-choice beats open-ended for the human — picking reading B takes five seconds. And the agreement set is *free spec*: everything all N readings shared becomes the draft body, needing a skim instead of authorship.

Two extensions aim squarely at parallel work:

- **Edge interrogation:** run the same fan per DAG edge — N agents independently author the interface implied by the two adjacent tickets. Divergence there *is* contract ambiguity, the precise quantity that breaks speculation and poisons merges. A converged edge is what licenses speculative execution on it.
- **The ambiguity router:** when a builder hits a question mid-flight, fan three cheap agents on it before any human sees it. If they *agree*, it was confusion, not ambiguity — answer mechanically, zero interrupts. If they *diverge*, it's real, and the human gets it as multiple choice. In a 5-wide run this is the difference between the human as interrupt-driven bottleneck and the human as occasional adjudicator.

## Field notes, so you don't rediscover them

Hard-won, encoded here rather than re-learned:

- **Preflight permissions.** Before any fan-out, dry-run every operation class the fleet will use — git, worktree add/remove, build commands, agent spawn — so approval prompts front-load into one batch. A permission prompt mid-flight is a hidden serialization point: one blocked agent × N teammates = N stalls. (`npx preflight`.)
- **In-flight validators are a different organ than prosecution.** A validator paired with a long-running builder, reviewing *as the work happens*, catches drift hours before the gate — and does not replace prosecution, which still runs fresh-context at the gate. Build gate proves it compiles; prosecution proves it does what the ticket asked. Different questions, both mandatory.
- **Pull, don't push.** Idle builders claim the next unblocked ticket from a shared queue (work-stealing) instead of receiving static assignments — absorbing the duration variance that static assignment converts into idle time. Sizing heuristic: 2–3 tickets per builder.
- **Integrator craft:** merge order is foundation → shared packages → apps, first-done-first-merged within a tier. After a squash-merge to main, never `git rebase main` (it replays pre-squash commits) — cherry-pick your unique commits onto a fresh branch. And disable formatter hooks during conflict resolution, then grep for stale conflict markers: formatters mangle `<<<<<<<` blocks into syntactically valid garbage.

## The dials, set

| Knob | Default | Override when |
|------|---------|---------------|
| Fan-out width | min(forecast-certified, build÷merge ratio) — typically 3–5 | Integration made faster → raise |
| Ticket size | ~1 useful context window | High integration overhead → bigger; low rail density → smaller |
| Builder model | ladder if float > retry latency, else direct best-tier | No manifest history yet → mid-tier direct, collect priors |
| Contract desk | Frontier, always | Never — contract stability funds the speculative schedule |
| Prosecutor pool | Mid-tier, calibrated, shared | Calibration shows a category blind spot → add a frontier lens there |
| Speculation | On, for any parallax-converged edge | Edge ambiguity above threshold → serialize that edge |

Notice what this table is: the three dials, each set by a *measurement* — forecast, float, calibration, ambiguity score — rather than by anyone's intuition. That's the through-line of the whole post. Orchestration intuitions ("about four agents feels right," "give the hard ticket to the big model") keep turning out to be shadows of computable quantities, and the computation is always cheaper than one bad merge.

Everything so far makes a single run reliable and parallel. None of it yet explains why run fifty should be *cheaper* than run five — why the lifecycle compounds instead of just repeating. That's the phase everyone skips, and the tools that make skipping it visible on a dashboard.

*Next: [The Lifecycle That Gets Cheaper Every Run →](./06-the-lifecycle-that-gets-cheaper.md)*
