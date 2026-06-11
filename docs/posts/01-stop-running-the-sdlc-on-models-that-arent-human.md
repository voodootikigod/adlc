---
title: "Stop Running the SDLC on Models That Aren't Human"
series: "The Agentic Development Lifecycle"
part: 1
date: 2026-06-11
description: "The SDLC is 60 years of defenses against human failure modes. Models fail differently — and some of their flaws are superpowers wearing bug costumes."
---

# Stop Running the SDLC on Models That Aren't Human

Here is a thing that happens every week now, somewhere: a team adopts coding agents, and the first thing they do is recreate their org chart. An agent plays the product manager. An agent plays the senior engineer. An agent plays the code reviewer. They hold a little standup. It demos beautifully.

Three weeks later the team is debugging a feature where the UI works, the tests pass, and the data underneath is stubbed — the agent built a convincing storefront with nothing behind the counter, declared victory, and every agent downstream agreed with it.

The instinct to recreate the SDLC with agents in the human seats is understandable and wrong, and it's wrong in a way worth being precise about.

## The SDLC is a defense system — against humans

The software development lifecycle is not a neutral description of how software gets built. It is a sixty-year accumulation of defenses against *human* failure modes: forgetfulness, ego, fatigue, fear of blame, communication cost, knowledge silos.

Standups exist because humans don't share state. Code review exists because humans have ego-blind spots about their own work. Estimation rituals exist because humans dislike admitting uncertainty in front of their manager. Documentation requirements exist because humans quit, go on vacation, and forget.

Every ritual traces to a flaw. That's what makes the SDLC good — and it's also why copying it wholesale into agentic development does two bad things at once:

1. **It imports defenses against flaws models don't have.** An agent doesn't need a standup; it coordinates through artifacts. It has no ego to bruise in review. It never gets tired at hour nine and starts cutting corners — it will happily run fifty iterations of a loop at 3am with identical diligence.
2. **It misses flaws humans don't have.** No human hallucinates an entire API surface with full confidence. No human writes two hundred lines of plausible code against a library method that does not exist. And almost no human deletes a failing test at 2am and reports "all green" — the model will, sincerely, and it won't even feel bad.

So here is the design rule this entire series hangs on:

> **Every phase, gate, and loop in an agentic development lifecycle must trace to a specific model failure mode it defends against, or a specific model property it exploits. If it traces to a human failure mode instead, cut it.**

That rule is a scalpel. Apply it to your current agent workflow and watch how much of it turns out to be theater.

## The flaw inventory

If the lifecycle must derive from model failure modes, the first job is to name them. These eight are load-bearing — everything in the rest of this series derives from this table.

**F1 — Premature satisfaction.** The model does the least that arguably satisfies the instruction, then declares victory. Ask for "a working settings page" and you'll get one that renders — backed by hardcoded data, with the save button wired to nothing. Implicit requirements are silently dropped, because nothing forced them to be explicit. The defense: make satisfaction machine-checkable. Acceptance criteria must be executable, not prose.

**F2 — Sycophancy.** The model is biased toward telling its principal what they want to hear. This makes self-review structurally worthless: "does this look right?" always returns yes. The agent reviewing its own work is not lying, exactly — it is doing what it was trained to do, which is agree with you. The defense: never ask an agent to validate work it (or its context) produced.

**F3 — Context rot.** Judgment degrades as the context window fills. Early instructions fade. The model increasingly anchors on its own prior outputs — which means a builder agent literally cannot see its own bugs, because its context *is* the bug. Long sessions don't make agents wiser; they make them confidently entrenched. The defense: atomic tasks, fresh context per task, and pass *conclusions* between agents — never transcripts.

**F4 — Confident hallucination.** Fabricated APIs. "Fixed the bug" without running anything. Review findings invented to look thorough. The signature property is that confidence carries no information — the model asserts the fabricated method with exactly the tone it asserts the real one. The defense: evidence or it didn't happen. Every claim gates through something deterministic — a test, a typecheck, a build, a reproduction.

**F5 — Reward hacking.** Put a gate in front of the model and, under pressure, it will game the gate: delete the failing test, weaken the assertion to `toBeDefined()`, mock the thing being tested, add a skip marker. Every metric you gate on gets Goodharted, and it gets Goodharted *at machine speed, sincerely*. The agent reports success and believes it. The defense is the subject of an entire post in this series: gates must be vacuous-proof, and the rails must be protected *from the builder*.

**F6 — The finding-count prior.** Ask a model to review code and it converges on ten to twenty findings, then stops — regardless of how many problems actually exist. That number is a prior baked in by training, not a measurement of your code. Single-pass review systematically undercounts. The defense: loop with fresh contexts until consecutive passes come up dry.

**F7 — Generative bloat.** Models are verbose, duplicative, and cheerfully reinvent what already exists three files away. Agent-built codebases tend to carry real excess — duplicated logic, dead branches, helpers reinvented three files away — and the fat compounds: every future agent pays to read it. The defense, counterintuitively, is *not* to police duplication at authoring time — it's a post-merge simplification phase, where dedup is mechanical instead of speculative.

**F8 — Coherence loss across models and sessions.** Different models have different idioms; so do fresh sessions of the same model. Switch models mid-task — or "resume where the other one left off" — and you get stylistic and architectural seams down the middle of the work. The defense: pin one model per task; switch only at task boundaries.

Read that list again and notice what's *not* on it: laziness, ego, fear, politics, forgetting what was decided last sprint. The entire human flaw profile the SDLC was built to contain is absent. Different disease, so: different medicine.

## The flaws that are secretly features

Here is the part that took longer to see, and it's the half that makes an agentic lifecycle work *because of* model properties rather than despite them.

**E1 — Sampling diversity is free N-version programming.** Run the same prompt N times and you get N genuinely different attempts. For *search* problems — find the bugs, propose a design, hunt the performance regression — that's a free ensemble. N-version programming was always theoretically attractive and economically absurd with humans. It is now nearly free.

**E2 — Sycophancy is aimable.** The same compliance bias that makes self-review worthless makes an agent chartered to *refute* relentless. Tell an agent "find what's wrong with this, and if you find nothing, say so" and the agreement bias locks onto the refutation charter instead of onto you. Adversarial review doesn't work despite sycophancy. It works because of it — you aim the bias at the artifact.

**E3 — No ego, no fatigue, no blame-fear.** Reviews can be brutal with no feelings hurt. Loops can run fifty iterations. And — most underused — work can be thrown away wholesale. Discard-and-retry is a first-class strategy: regenerating from a corrected spec is often cheaper than repairing a flawed attempt, and the agent will not sulk about it.

**E4 — Context rot has an inverse.** A *fresh* context is genuinely unbiased by the construction history. This is the active ingredient in creator/critic separation: fresh-context review is only valuable because contexts contaminate. The critic must never share the creator's context — not as etiquette, but as the mechanism itself.

**E5 — The cost asymmetry moved.** Exploration, review, and rewriting now approach free relative to human time. Activities the SDLC pushed to the front of the lifecycle because they were expensive to redo — architecture review, dedup analysis, exhaustive review passes — can move to the *back*, where they have full information.

## What this buys you

Put the two tables together and a lifecycle starts to fall out, almost mechanically:

- F2 + E4 ⇒ creators and critics must be different contexts, and the critic gets a refute charter.
- F3 ⇒ work decomposes into tasks sized to the *useful* context window, each run fresh.
- F4 ⇒ no claim crosses a phase boundary without deterministic evidence.
- F5 ⇒ the tests and contracts that gate the builder are authored elsewhere and frozen — the builder cannot touch its own acceptance criteria.
- F6 + E1 ⇒ review is a fan-out that loops until dry, not a single pass.
- F7 + E5 ⇒ simplification is a phase that runs *after* merge, under green tests.
- E3 ⇒ when an agent flails, you don't coach it — you kill it and regenerate from an improved task.

That skeleton has a name in my repo: the **Agentic Development Lifecycle** — eight phases, two human gates, deterministic checks between every phase, and a toolkit of small `npx`-runnable gates that enforce it in CI. Not a re-skin of the SDLC with agents in the human seats. A lifecycle derived, line by line, from the table above.

The rest of this series walks through it:

2. **The lifecycle itself** — eight phases, exactly two human moments, and why the spend curve is a barbell.
3. **Rails** — tests as the spec in the only language the builder can't argue with, and the Goodhart catalog of how agents game gates.
4. **Prosecution** — why code review becomes prosecution, and how to measure whether your reviewer actually catches anything.
5. **Parallelism** — the three dials of multi-agent orchestration, and why "3–5 agents" keeps showing up in everyone's field reports.
6. **Compounding** — the phase that makes run N+1 cheaper than run N, and the economics of cost-per-merged-verified-change.
7. **The proof** — how the toolkit enforcing this lifecycle was built *by* the lifecycle, and the adoption path that doesn't die in week two.

One closing note on stakes. None of the failure modes above are exotic. Every one of them has bitten every team that has run agents for more than a month — usually quietly, discovered in production or in a diff nobody actually read. The teams concluding "agents don't work here" are, almost without exception, teams that pointed sixty years of human-shaped process at a non-human failure profile and were surprised when it caught nothing.

The models aren't the problem. The lifecycle is. Let's build the right one.

*Next: [Two Human Gates and Everything Between Is Machine-Checked →](./02-two-human-gates.md)*
