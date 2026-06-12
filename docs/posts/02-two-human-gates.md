---
title: "Two Human Gates and Everything Between Is Machine-Checked"
series: "The Agentic Development Lifecycle"
part: 2
date: 2026-06-11
description: "Eight phases, exactly two mandatory human moments, deterministic gates between everything — and a spend curve shaped like a barbell."
---

# Two Human Gates and Everything Between Is Machine-Checked

[Last post](./01-stop-running-the-sdlc-on-models-that-arent-human.md) laid out the argument: the SDLC defends against human failure modes, models fail differently, and every phase of an agentic lifecycle must trace to a specific model flaw it defends against or a model property it exploits.

This post is the lifecycle that falls out of that rule. Eight phases. Deterministic gates between every pair. And — this is the part people fixate on, so let's lead with it — exactly **two** mandatory human moments in the entire loop.

## The shape

```
P0 Triage → P1 Interrogate → P2 Decompose → P3 Rail → P4 Build → P5 Prosecute → P6 Integrate → P7 Distill
                │ human gate    │ cold-start     │ RED gate  │ green     │ zero-findings   │ human gate     │ feeds the
                                │ gate           │           │ gate      │ gate            │                │ next run
```

Before walking through it, one principle that governs all the arrows: **an LLM→LLM handoff without a deterministic checkpoint multiplies error rates.** The chain is only as strong as its non-LLM links. Between any two phases there must be something that cannot hallucinate — a compiler, a test suite, a schema validator, a human. Probabilistic components in series compound their error; deterministic gates between them reset it.

### P0 — Triage

Not everything earns the full lifecycle, and running the full ceremony on a typo is how agentic lifecycles die of friction in week two. Route by **risk × blast radius**, not size:

- **Trivial** (copy change, config tweak with existing coverage): direct edit, existing tests, one review pass. Cheap model.
- **Bounded** (bug fix inside one module): skip straight to P3 — write the failing test that *is* the bug report, fix, light review.
- **Substantial** (new feature, cross-cutting change): full lifecycle.
- **Architectural** (new system, contract changes): full lifecycle plus design alternatives evaluated by a judge panel.

### P1 — Interrogate

The single highest-leverage phase, because error here compounds through everything after it, and no downstream gate can catch "built the wrong thing correctly."

The mechanism is interrogation: *ask me questions until you have none left — but check the codebase before asking each one.* That second clause is the half that matters. Without it you get twenty questions the repo already answers, and the human tunes out by question six.

Here's the framing correction that took me a while: people say planning "reduces non-determinism," and that's wrong in a way that matters. Sampling randomness is not the enemy — at temperature zero, a vague spec still yields confidently wrong code. The enemy is **underspecification**. The model fills every gap with its prior, and its prior is "whatever is most generic." Interrogation works by transferring the spec from your head into the context *before* the gaps get filled by invention. (That's flaw F1 from post 1 — premature satisfaction — being starved of gaps to exploit.)

The output is a spec where **every acceptance criterion names its verification method** — a test to be written, a command whose output is asserted, a behavior demonstrated. A criterion with no verification method is a wish, and wishes get the minimum-effort treatment.

**Gate: a human approves the spec.** This is human gate one of two, and it is the human's highest-value moment in the entire lifecycle. Minutes here replace hours of diff review later. Use the best model you have in this phase and don't economize — a subtly wrong spec sails through every downstream gate and poisons everything.

### P2 — Decompose

Defends against context rot (F3). The unit of work is sized to the *useful* context window — the region before judgment degrades — not the advertised one.

Slice the spec into atomic tickets, each executable by a fresh agent from the ticket text alone. Draw partition lines along interfaces, and write the **contract at each boundary explicitly** — types, schemas, endpoint shapes. Contracts are what let the build phase parallelize safely; parallel agents that collide do so on shared types and configs, never on feature code. Pin the shared surface first and parallel construction stops colliding.

**Gate — the cold-start test:** hand each ticket to a fresh, *cheap* model and ask "what's missing to execute this without asking a single question?" If a cheap model can enumerate the gaps, the ticket is underspecified for the mid-tier model that will actually run it. Costs pennies per ticket. Catches the number-one cause of build-phase flailing before a more expensive model burns dollars discovering it. (`npx coldstart` — exit 0 clean, exit 2 with the gap list.)

### P3 — Rail

The trust anchor of the whole lifecycle: tests, type stubs, and contracts authored from the spec **in a context that will never see the implementation**, then frozen. The builder cannot edit them. The next post is entirely about this phase, so here, just the gate:

**Gate: the suite runs RED for the right reasons** — failures say "not implemented," not "test is broken" — and the stubs typecheck.

### P4 — Build

One fresh agent per ticket: ticket + relevant skills + frozen rails. No carry-over context between tickets (F3 again). Parallelize across partitions in git worktrees, single writer per partition, merge sequentially.

Mid-tier model by default. This surprises people, so it gets its own principle: **model tier is a function of the cost of *detecting* an error, not of task prestige.** Where the rails are dense, errors are caught instantly and deterministically, so the cheapest model that clears the gates is the correct one. Where errors are expensive to *find* — specs, contracts, migrations without coverage — that's where the frontier model goes. This inverts the common instinct (best model writes the code). The code is the most-verified artifact in the system; the spec is the least.

Two operational rules worth stealing even if you adopt nothing else:

- **Two-strike regeneration.** If an agent flails — loops on the same error, starts touching files outside its ticket — do not coach it inside the same rotting context. Kill it, append the dead-ends to the ticket ("known failed approaches: …"), start fresh. If the regeneration also fails, the *ticket* is wrong; escalate to P2, not to a bigger model. The second-cheapest fix is a fresh start; the most expensive is a long conversation with a confused agent.
- **No personas.** "You are a senior Next.js engineer with 15 years of experience" adds vibes, not capability. An agent is its context, tools, charter, and gate. Skills add capability; charters add direction; costumes add tokens.

**Gate: rails green, build passes, lint passes.** Deterministic. No opinions.

### P5 — Prosecute

Not "code review." Prosecution: fresh contexts chartered to *refute*, with the burden of proof on the finding — every finding is reproduced by a verifier or killed before anyone acts on it, and the fan-out loops until two consecutive passes come up dry. Post 4 covers this phase and the tooling that measures whether your review stack actually catches anything.

**Gate: zero verified open findings, rails still green, and the rails diff is empty** — mechanical proof the builder never touched the tests.

### P6 — Integrate

Human gate two — and it is *not* "read the diff."

The 5,000-line diff read is litmus theater. The human scrolls, pattern-matches for nothing in particular, approves, and the org books "human in the loop." Human attention is the scarcest resource in the lifecycle; spend it where machines are blind:

- Read the **spec-conformance summary**: what was promised, what was verified, what was explicitly not done.
- Read the **test diff** — small, high-signal, and it *is* the behavioral contract.
- **Run the thing.** A two-minute demo catches the one category of wrongness no reviewer-agent can: "this is technically correct and not what I meant."
- Spot-check the two or three hotspots prosecution flagged. Not the whole surface.

**Gate: human behavioral acceptance.** "Is this what I meant, *running*?"

### P7 — Distill

The phase everyone skips, which is why their costs stay flat while their codebases bloat. Two halves: **simplify** (post-merge dedup and dead-code removal under the still-green rails — expect a substantial reduction on agent-generated code) and **mine** (recurring review findings become lint rules; recurring interrogation questions become spec templates; conventions become skills). This is the compounding loop — post 6 is devoted to it.

## The two human gates, stated plainly

The entire lifecycle has exactly two mandatory human moments, by design:

1. **P1: "Is this what I meant?"** — spec approval.
2. **P6: "Is this what I meant, running?"** — behavioral acceptance.

Everything between them is machine-gated. Humans intervene elsewhere only on escalation: non-converging loops, out-of-scope flags, contract changes. This is not human-out-of-the-loop. It is human-at-the-two-points-where-human-judgment-is-irreplaceable, instead of human-as-tired-diff-scroller. The human is the ground truth for *intent*, and intent is checked exactly twice — once as words, once as behavior.

## The barbell

Where does the money go? Heavy at the ends, light in the middle:

```
P1 Interrogate  ██████░░   heavy — best model, human time; cheap insurance
P2 Decompose    ███░░░░░   moderate — frontier for contracts
P3 Rail         ███░░░░░   moderate — one-time per feature
P4 Build        ██░░░░░░   light — skills + rails make this cheap
P5 Prosecute    ██████░░   heavy — fan-out × loop-until-dry; where quality is bought
P6 Integrate    █░░░░░░░   human minutes, not hours
P7 Distill      ██░░░░░░   light — and it discounts every future run
```

If your spend is concentrated in P4 — the build — your team is *exploring* (re-reading the codebase every run) instead of *exploiting* (skills, atomic tickets, cached context). That's a diagnostic, not a judgment; it tells you which phase is missing.

The barbell also explains why this lifecycle reads as heresy to agile instincts. Agile economized on planning because human building was slow and specs went stale before the build caught up. Building is now fast and cheap; **mis**building is what's expensive. The economics inverted, so the phase weighting inverts. "Working software over comprehensive documentation" was a correct response to 2001's cost structure. It is the wrong response to this one.

## Norms rejected

Positions this lifecycle takes deliberately, so you can disagree deliberately:

| Norm | Verdict | Why |
|------|---------|-----|
| Human review of full agent diffs | **Reject** | Theater past ~500 lines. Attention goes to spec, test diff, behavior |
| Agile-weight planning | **Reject for agentic work** | The economics inverted; see above |
| Persona engineering | **Reject** | Capability lives in skills, tools, charters. Costumes are token overhead |
| Multi-agent *collaborative construction* (3–7 creators comparing notes) | **Reject** | Search-parallelism misapplied to construction. Partition + contract + single writer instead |
| DRY at authoring time | **Reject** | Dedup moves to P7, where it's mechanical instead of speculative |
| Coverage % as a quality gate | **Reject** | Goodharted at machine speed. More in the next post |
| Token quotas as cost control | **Reject** | Caps the wrong variable. A quota-pressured developer cuts the review phase first — the most valuable tokens in the system. Govern cost per merged, verified change instead |
| Mid-task model failover | **Reject** | Coherence loss (F8). Models switch at task boundaries only |

Every row traces back to the flaw inventory. That's the test: if you find yourself adding a ritual that doesn't trace, you're importing human-shaped process again.

Next up is the phase the whole structure leans on. There's a sentence in the lifecycle doc that I think is the most important one in it: *in the SDLC, tests verify the code; in the ADLC, tests are the spec rendered in the only language the builder can't argue with.* The builder will try to argue anyway — by editing the tests. What happens then is the subject of post 3.

*Next: [Tests Are the Spec in the Only Language the Builder Can't Argue With →](./03-tests-are-the-spec.md)*
