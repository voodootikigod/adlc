---
title: "We Built the Toolkit With the Lifecycle"
series: "The Agentic Development Lifecycle"
part: 7
date: 2026-06-11
description: "Eighteen gate-shaped tools, built by the lifecycle they enforce — plus the frontier-free doctrine, the honest loss account, and the adoption path that doesn't die in week two."
---

# We Built the Toolkit With the Lifecycle

Six posts of doctrine deserve a proof-of-work. Here it is: the toolkit that enforces this lifecycle was built *by* the lifecycle — eighteen tools, constructed in parallel by a deterministic workflow script that pipelined each one through build → prosecute → fix, exactly the loop [posts 2 through 5](./02-two-human-gates.md) describe.

The shape of that run, briefly, because it's the whole series in miniature. A frozen contract came first: a small shared core (`@aidlc/core` — LLM calls, git plumbing, CLI conventions, the findings ledger) was built, tested, and *merged before any fan-out*, then appended read-only to every tool's ticket — the "pinned means merged" rule from [post 5](./05-three-dials-parallel-agents.md), applied literally. Each tool then got a fresh builder agent with its ticket and rails; each build was prosecuted by fresh-context reviewers; verified findings looped back as fix tickets; the orchestrator was a workflow script — control flow as code, judgment as spawned models, no boss agent deciding what happens next. The tools came out the other end zero-dependency, `npx`-runnable, with deterministic exit codes (0 = pass, 2 = gate fails) so every one can sit in CI.

And then the toolkit was aimed at itself: `review-calibration` planted bugs in the toolkit's own diffs to measure whether the prosecution stack that built it would catch them — including a one-line truthiness guard in `gate-manifest`'s own hash-chain verifier that made the provenance tool silently skip verification ([post 4](./04-prosecution-not-code-review.md) shows the diff). Dogfooding doesn't get more circular than calibrating the reviewer against the tool that proves the reviewer ran.

## The toolkit, by phase

Every tool earns its place the same way every phase did: it traces to a model flaw defended or a model property exploited ([post 1](./01-stop-running-the-sdlc-on-models-that-arent-human.md)). Same DNA throughout: small, fresh contexts by construction, gate-shaped.

**Specify**

| Tool | What it gates |
|------|---------------|
| `spec-lint` | Every acceptance criterion must name its verification method. Criteria without one are wishes — exit 2 lists the wishes |
| `premortem` | Fresh frontier context, one charter: "this project failed three months from now; write the postmortem." Inverted sycophancy as a stress test |
| `parallax` | Measured ambiguity: N independent readings of the request, divergence becomes multiple-choice questions, convergence becomes a score the gate can check |
| `coldstart` | Each ticket to a cheap fresh model: "list everything missing to execute this." Non-empty list = underspecified ticket, exit 2 |

**Rail + Build**

| Tool | What it gates |
|------|---------------|
| `rails-guard` | Mechanical rail freeze: blocks builder edits to test/contract/CI paths, emits the rails-diff-empty proof, greps for new skip/suppress markers |
| `hollow-test` | Diff-scoped mutation testing: surviving mutants are proof of hollow coverage. The honest replacement for coverage % |
| `preflight` | Environment determinism before fan-out: dry-run every operation class the fleet will use, front-load the permission prompts |
| `merge-forecast` | Partition safety: pairwise conflict scoring (file scope, import radius, co-change history, namespace collisions), float computation, width recommendation |
| `model-router` | Tier by escape cost and DAG float, priors from the manifest ledger. Ladder when float absorbs retries, direct when on the critical path |
| `flail-detector` | The two-strike rule, mechanized: detects loop signatures, kills the session, appends dead-ends to the ticket, regenerates fresh. Second strike escalates to decomposition |
| `consensus-fix` | N-version programming for hard bugs: fan N fresh agents at the failing test, agreement = confidence, divergence = the spec is ambiguous about something load-bearing |

**Prosecute**

| Tool | What it gates |
|------|---------------|
| `review-calibration` | Planted-bug recall of the whole review stack, per category. Turns "we do adversarial review" into a number; re-run on every model change |

(The prosecution loop itself runs on `adversarial-review`, which predates this toolkit — fresh-context cross-model review with deterministic exit codes for CI.)

**Integrate**

| Tool | What it gates |
|------|---------------|
| `behavior-diff` | Diff in behavior space, not code space: API responses, rendered routes, CLI outputs, before vs. after. The 5,000-line code diff becomes six human-readable behavioral items |
| `gate-manifest` | The evidence chain: every gate appends a signed entry — test hashes, rails-diff proof, prosecution verdicts with the calibration score that qualifies them, models used, spend per phase. A merge ships with its provenance |

**Distill**

| Tool | What it gates |
|------|---------------|
| `lesson-foundry` | The ratchet: clusters recurring verified findings, routes each to its cheapest permanent defense — lint rule, skill candidate, or interrogation question |
| `skill-rot` | Cache invalidation for knowledge: extracts each skill's verifiable claims, checks them against the repo, stamps `last-verified`, exits 2 with the stale list |
| `model-ratchet` | The free re-audit: on model release, re-prosecute main's hot paths with the newest models; verified findings feed the foundry |
| `rejection-mining` | Mines gatekeepers' recorded "no"s from PR history and rejection docs into prosecution lenses and pre-flight checklists |

(`skill-mining`, also predating the toolkit, handles the skill-extraction half of Distill.)

## The frontier-free doctrine

Here's the constraint that shaped the toolkit and turns out to be a doctrine: the lifecycle must hit its accuracy targets with mid-tier models — Opus, Sonnet, Haiku-class, no frontier-of-frontier access. Not as a degraded mode but as the design center. (It's also the common enterprise reality: approved-model lists, quota ceilings, procurement lag.)

The premise: the gap between a mid model and a frontier model is almost entirely a gap in *single-pass judgment* — depth of insight per forward pass, coherent horizon, knowing-what-it-doesn't-know. The doctrine: at every point where the lifecycle appears to need single-pass judgment, buy the same outcome with structure instead. Five substitutions:

1. **The generator–verifier gap is the engine.** Recognizing a correct artifact is easier than producing one; *checking* one deterministically is easier still. Generate wide and cheap, verify deterministically, select with a mid model. The quality of output decouples from the generator and couples to the verifier — and this lifecycle's verifiers are tests, types, contracts, and hash chains: model-free. **You never need a model smarter than the gate it must pass.** That's the doctrine in one line.
2. **Search replaces insight.** What a frontier model produces in one pass, a mid model produces as the best of N diverse attempts — judge panels for design, consensus for hard bugs, loop-until-dry for review breadth. And `review-calibration` makes the exchange rate a *number*: if a 3-pass mid-tier prosecution stack shows 0.85 planted-bug recall and a single frontier pass shows 0.6, the stack **is** the more capable reviewer. Measure the stack, never the model.
3. **Decomposition replaces horizon.** Ticket size is tier-indexed: a cheap model that only ever sees a few thousand tokens of well-railed ticket is not operating below the frontier — it's operating below its own degradation point, which is the only line that matters.
4. **Banking replaces presence.** Rent the big model occasionally to mint structure — contracts, skills, templates, lints — then spend mid-tier inside that structure indefinitely ([post 6](./06-the-lifecycle-that-gets-cheaper.md) is this substitution, run as a flywheel). Capability migrates from the model tier into the artifact layer, where it compounds instead of being re-billed per token.
5. **Measurement replaces metacognition.** The capability mid models most lack is knowing what they don't know — so never ask. `parallax` swaps "do you have questions?" for divergence-of-N-readings; `consensus-fix` swaps "are you sure?" for agreement statistics; `coldstart` swaps "is this clear?" for an enumerated gap list. None need a smarter model. They need more samples and a division operation.

And the sixth substitution is the one this series opened with: **humans are the frontier tier.** The two human gates sit exactly where frontier judgment would otherwise go — "is this what I meant?" and "is this what I meant, running?" — because the human *is* the ground truth for intent, and the tooling (`behavior-diff`, the manifest, parallax's multiple-choice questions) exists to compress what the human must absorb so the minutes stay minutes.

The honest loss account, because doctrines without one are marketing: you give up single-pass architectural elegance (mitigated by judge panels + premortem + the human at the spec gate, and the residue is real); subtle cross-cutting bug intuition (loop-until-dry raises recall asymptotically, `model-ratchet` schedules the deep read for whenever a stronger model ships); latency (N passes are slower than one brilliant pass — recovered by parallelism); and long-horizon refactors that resist decomposition (the genuinely hard residue — serialize them, best available model, densest rails, in-flight validator, and accept that ~5% of work runs at maximum supervision). Net: a capability shortfall converted into a compute-plus-process bill, with gates keeping the conversion honest. And when the constraint lifts, nothing is wasted — every mechanism here amplifies a frontier model exactly the way it amplifies a mid one.

## Adoption: relief first, lifecycle later

The field wisdom that outranks everything else in this post: **teams do not adopt platonic lifecycles; they adopt relief from their worst pain point**, then ask what else hurts. Sequencing for a real team:

1. **Prosecution of existing PRs** (post 4, standalone). Highest pain — nobody wants to review the 5,000-liner — zero workflow change, and trust gets built on verified findings the team can check themselves. Include finding-verification from day one: a single hallucinated finding wastes an hour of human time and burns a week of credibility.
2. **Rails** (post 3). "You hate writing tests? The agent writes them from the spec; you audit them once." This quietly installs the trust anchor everything else hangs on.
3. **Interrogation** (post 2). Once the team has watched agents miss implicit requirements a few times, the case for spec interrogation makes itself.
4. **Full loop with parallelism** (post 5) and **distillation** (post 6). Last, because worktree fan-out and the compounding flywheel only pay off once 1–3 are habits.

The anti-pattern is mandating the full lifecycle org-wide on day one. The ceremony overhead lands before the compounding gains do, quota anxiety kicks in, and the org concludes "agents don't work here" — which, as post 1 argued, is the conclusion of teams that pointed human-shaped process at a non-human failure profile. Don't hand them a second wrong-shaped process at higher ceremony.

## The through-line

Seven posts, one move, made over and over: **replace trust with structure, and structure with measurement.**

Don't trust the builder's claim — gate it with a test it cannot edit. Don't trust the reviewer's thoroughness — plant bugs and count. Don't trust the model's questions — fan out readings and diff them. Don't trust the partition — forecast the conflicts before paying for the fan-out. Don't trust the knowledge layer — verify its claims weekly and stamp the date. Don't trust the org's memory — cluster the findings and compile them into lints. And don't trust the lifecycle itself — give it a unit of account (cost per merged, verified change) and check that the curve bends down.

None of it requires smarter models. All of it gets *better* with smarter models — every mechanism amplifies whatever you run through it, which is what makes it a lifecycle rather than a workaround. The SDLC took sixty years to accrete its defenses against human nature. We get to build the agentic one deliberately, from a flaw inventory, in public, with gates that prove themselves in CI.

The doctrine is one document and the tools are one repo. Run `npx coldstart` on your next ticket, or `npx review-calibration` against your current review stack — the first calibration number is reliably humbling, and it's the right place to start. Everything here traces to a flaw or an exploit; if you find a phase that doesn't, cut it — and if you find a flaw without a phase, that's the next tool.

*Start of series: [Stop Running the SDLC on Models That Aren't Human →](./01-stop-running-the-sdlc-on-models-that-arent-human.md)*
