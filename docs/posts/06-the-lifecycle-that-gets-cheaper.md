---
title: "The Lifecycle That Gets Cheaper Every Run"
series: "The Agentic Development Lifecycle"
part: 6
date: 2026-06-11
description: "Distillation, the lessons ledger, skill rot, and the model ratchet — the compounding loop that bends the cost curve down, and the unit of account that makes it visible."
---

# The Lifecycle That Gets Cheaper Every Run

Five posts in, the lifecycle can take a request from interrogated spec ([post 2](./02-two-human-gates.md)) through frozen rails ([post 3](./03-tests-are-the-spec.md)), prosecution-until-dry ([post 4](./04-prosecution-not-code-review.md)), and a calibrated parallel fan-out ([post 5](./05-three-dials-parallel-agents.md)) to a merged, verified change. Run it again next sprint and it works again.

That's not good enough, and this post is about why. A lifecycle that merely *repeats* leaves the defining economic property of agents on the table. Human teams compound by default — people remember, develop taste, stop making last quarter's mistakes. Agents remember nothing. Every run starts from zero unless something *deliberately* carries the lessons forward. Skip that something and you get the signature cost curve of most agent adoption: spend flat run-over-run, the codebase bloating quarter over quarter, the same bug categories found — and paid for — every sprint.

The something is P7, **Distill**, and it has two halves.

## Half one: simplify — the architectural review moved to where the information is

Models are verbose and duplicative; they reinvent what exists three files away (F7 from [post 1](./01-stop-running-the-sdlc-on-models-that-arent-human.md)). Agent-generated codebases tend to run meaningfully fatter than necessary, and the fat compounds — every future agent pays input tokens to read it, and every future context window carries it as noise.

The counterintuitive move is *when* to fight this. The instinct — enforce DRY at authoring time, police duplication in review — is wrong for agents, for a reason worth spelling out: **deduplicating before the code exists is speculative.** You're guarding against duplication that sampling non-determinism may never materialize where you guarded. Deduplicating *after* merge is mechanical: the duplication is sitting there, findable by analysis, removable under tests.

So the simplify pass runs post-merge, under the now-green, still-frozen rails: dedupe, extract shared utilities, clarity-over-cleverness rewrites, dead-code removal. The rails define "behavior preserved," which is what lets a cheap-to-mid model do this safely — the rails carry the risk, exactly as designed in post 3.

Notice what this is, in classical terms: the architecture/design review, moved from the front of the lifecycle to the back. The SDLC put design review up front because rework was expensive — you reviewed the blueprint because rebuilding the house was ruinous. Rework is now nearly free (E5), but *information* still accumulates: after the merge you know what was actually built, what actually got duplicated, which abstractions actually repeat. Review with full information beats review with speculation, so the expensive analysis moves to where the information lives. Same review, better-informed, and the lifecycle's economics are what made the move legal.

## Half two: mine — every lesson paid for exactly once

Here's the diagnostic that motivates everything in this half: **if your prosecution spend trends up over time, your lifecycle is re-buying the same lessons.** The same error-swallowing pattern found in March, April, and May. The same missing-auth-check caught — at LLM-review prices — every single sprint. Each catch costs dollars of fan-out and verification. The lesson was learned, billed, and thrown away, three times.

`npx lesson-foundry` is the ratchet that stops this. Verified prosecution findings accumulate in a JSONL ledger across runs (the adversarial-review output feeds it naturally). The foundry clusters recurrences, then routes each cluster to its **cheapest permanent defense**:

- **Deterministic-able** → author a lint rule or grep gate, *with a test for the rule*, PR'd like any other code. The recurring finding is now caught at CI speed, for free, forever.
- **Contextual** (can't be a lint, needs judgment) → emit a skill candidate into the skill-mining pipeline, so every future builder loads the convention before writing code.
- **Spec-gap** (the bug existed because nobody asked) → append a question to the interrogation template, so the spec phase asks it on every future feature, forever.

Every defense gets fresh-context validation before landing — the foundry's output is code and gets prosecuted like code. The effect is a one-way ratchet: each lesson is paid for exactly once, then demoted from probabilistic detection (LLM review, ~dollars per catch) to deterministic detection (lint, ~free forever). Run by run, the prosecution fan-out finds less because the lint layer catches more — which is precisely the cost curve bending down.

This generalizes past code, in two directions worth naming. **Mine the harness:** orchestration bugs — the plan-approval loop that livelocks spawned agents, the formatter that mangles conflict markers — are lessons too; the ledger carries them alongside code findings. And **mine the institution:** `npx rejection-mining` scans historical PR review threads, declined PRs, and security/platform rejection docs; clusters each gatekeeper's recurring "no"s; and compiles them into prosecution lenses and pre-flight checklists. "Would security reject this?" becomes a question answered in seconds pre-submit instead of in days post-queue. Every recurring institutional objection becomes a gate the work passes *before* it reaches the institution.

## The cache problem: knowledge rots

Banked knowledge has a failure mode of its own, and it's nastier than having no knowledge at all.

**Every artifact a future agent reads is a cache, and caches need invalidation.** Skills, spec templates, memory files, conventions docs — all of it goes stale as the codebase moves. And a stale skill is worse than no skill: it's misinformation delivered *with the voice of authority*, loaded automatically into every future agent's context, asserting that the command is `npm run deploy` when the script was renamed two months ago. The agent trusts it — that's what the knowledge layer is *for* — and confidently does the wrong thing.

`npx skill-rot` is the invalidation sweep: for each skill file, extract its verifiable claims — commands, file paths, package versions, API names — and check them against the current repo, mechanically where possible, cheap-model where not. Stamp `last-verified` on what passes; exit 2 with the stale list. Weekly, in CI, like any other freshness check. The mining half of P7 re-mines idempotently for the same reason: refresh what drifted, delete what died.

## The free re-audit nobody runs

One more compounding mechanism, this one exploiting the outside world's progress instead of your own.

Everyone reviews new code with the current model and never looks back. But **every frontier model release is a free re-audit of your existing codebase** — the new model finds what the old one missed, and the old one *did* miss things (post 4 measured exactly how much). The code merged under last year's review stack carries last year's escape rate, sitting there, waiting.

`npx model-ratchet` schedules the harvest: on model release (or monthly), re-run the prosecution fan-out over main's hot paths — ranked by churn × criticality — with the newest models. Verified findings become tickets and feed the lesson-foundry like any other. Codebase quality ratchets monotonically with the frontier, for the cost of a cron job. Pairs naturally with calibration: measure the new model's recall first ([post 4](./04-prosecution-not-code-review.md)), then aim it at the backlog.

## The unit of account

None of the above shows up on the metric most orgs actually track, which is why most orgs skip P7. So, the economics, stated bluntly:

**The unit of account is cost per merged, verified change** — not tokens per developer per month. Token-efficiency improvements that lower merge quality are losses wearing savings costumes. And token *quotas* as cost control cap the wrong variable entirely: a quota-pressured developer cuts the prosecution phase first, because it's the most visible spend — and it's also the most valuable spend in the system. Govern cost-per-merged-verified-change; let the gates, not the wallet, end loops. (For scale: $1k/week of agent spend annualizes to roughly 15% of a senior engineer's loaded cost — a real fraction, but the wrong variable to cap. The right question was never "is $1k too much?" It's "did it merge, verified?")

With the right unit of account, the spend *shape* becomes a diagnostic instrument. Four readings:

- **Spend concentrated in the build phase** → the team is re-exploring the codebase every run: missing skills, oversized tickets, or no distill phase. Build should be the *cheap* part — that's what the barbell (post 2) means.
- **Prosecution spend trending up** → the foundry isn't converting findings into lints and skills; you're re-buying lessons. This is the most common broken loop and the easiest to confirm: look for the same finding category in three consecutive runs' ledgers.
- **Prosecution loops hitting max iterations** → specs are underdetermined. The problem is in interrogation; the bill shows up in prosecution. Fix the phase upstream of where the symptom presents.
- **Spend flat run-over-run** → the compounding loop is broken somewhere. The entire point of P7 is that this curve bends down; flat is a failure signal, not a steady state.

That last one deserves its own sentence, because it's the thesis of this post: **flat cost is failure.** A healthy agentic lifecycle gets measurably cheaper per change as the skill library grows, the lint layer thickens, the interrogation templates accumulate questions, and the routing priors converge. Run N+1 cheaper than run N — not as aspiration, as the observable output of a working ratchet, visible in the ledger.

## The full loop, closed

Trace one finding all the way around, because this single trip is the whole argument: a prosecutor catches an error-swallowing pattern (P5, dollars). The verifier reproduces it; the builder fixes it; it merges (P6). The foundry clusters it with two prior occurrences and authors a lint rule with a test (P7, dollars, *once*). Next sprint, a builder introduces the same pattern — and CI catches it in milliseconds, for free, before prosecution ever runs. The sprint after that, the interrogation template asks about error handling up front, and the pattern never gets written at all.

Detection migrated from expensive-and-probabilistic to free-and-deterministic to *prevented-by-specification*. That migration, repeated across every recurring lesson, is what "the lifecycle compounds" means mechanically. Capability is migrating from the model tier into the artifact layer — skills, lints, templates, priors — where it compounds instead of being re-billed per token.

Which sets up the next post's question. If capability lives in the artifact layer, how much model do you actually need? The toolkit this series describes was built — eighteen tools, built by the lifecycle itself, inside one of its own workflow scripts — under a deliberate constraint: mid-tier models everywhere the rails were dense, frontier only where errors escape detection. The doctrine generalizes, it has a one-line form ("you never need a model smarter than the gate it must pass"), and it comes with an honest account of what you give up.

*Next: [We Built the Toolkit With the Lifecycle →](./07-we-built-the-toolkit-with-the-lifecycle.md)*
