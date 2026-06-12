---
title: "Prosecution, Not Code Review"
series: "The Agentic Development Lifecycle"
part: 4
date: 2026-06-11
description: "Refute charters, findings-as-claims, loop-until-dry — and review-calibration, the tool that answers the question nobody asks: does your review stack actually catch anything?"
---

# Prosecution, Not Code Review

[Post 3](./03-tests-are-the-spec.md) ended on the limits of rails: tests deterministically catch everything the spec encoded, and nothing it didn't. The race condition nobody thought to test. The auth check missing from the endpoint the spec forgot. The error swallowed two layers below the happy path. Catching those takes judgment — and judgment from models comes with the failure modes from [post 1](./01-stop-running-the-sdlc-on-models-that-arent-human.md) attached: sycophancy (F2), hallucinated findings (F4), and a mysterious tendency to stop at fifteen findings regardless of how many exist (F6).

So the lifecycle's review phase isn't review. It's **prosecution**: fresh contexts chartered to refute, with the burden of proof on the finding. Four mechanisms, each traceable to a flaw or an exploit.

## 1. Refute charters, not review charters

"Review this code" is a request for the model's agreement bias to find a comfortable resting place. You get a paragraph of praise, two style nits, and "overall this looks solid!" — sycophancy with a rubric.

"**Find what's wrong with this, and if you find nothing, say so**" is a different machine. The same compliance bias that makes self-review worthless locks onto the refutation charter and becomes relentless (E2 — the flaw-as-feature). You're not fighting the model's eagerness to please; you're aiming it at the artifact instead of at yourself.

This is the same inversion that powers the `premortem` tool at the spec phase, and it's worth naming as a general technique: an agent asked "any problems with this plan?" says no; an agent told "this project failed three months from now — write the postmortem" invents concrete, checkable risks. Don't ask models to evaluate. Ask them to explain a failure you've stipulated.

## 2. One lens per context

Prosecution fans out: parallel reviewers, each owning exactly one dimension — correctness, security, contract conformance, the spec-vs-implementation diff, and one reviewer dedicated to auditing the tests the builder added during the build. (Builder-written unit tests are allowed, per post 3 — they're just work product, and work product gets prosecuted.)

Why one lens each? Context rot in miniature (F3): a reviewer with five concerns has the judgment of none. Asking one context to simultaneously hold security posture and off-by-one vigilance and contract conformance dilutes all three. Five narrow prosecutors beat one broad one, and they run in parallel anyway, so the wall-clock is identical.

Crucially, the prosecutors are **fresh contexts** — they never see the builder's transcript, only the diff, the spec, and the contracts. The fresh context is the active ingredient (E4): a context that watched the code being written inherits the builder's assumptions, including the wrong ones. The critic's value is precisely its ignorance of how the sausage was made.

## 3. Findings are claims — reproduce or kill

Here is the dominant failure mode of naive creator/critic loops, and almost everyone running them hits it within the first week: **the critic hallucinates findings, and the builder dutifully fixes them.**

F4 cuts both ways. A model chartered to find problems will *find* problems — including ones that don't exist, reported with exactly the confidence of the real ones. Forward unverified findings to the builder and it churns real code to address fake issues: refactoring around a race condition that can't occur, adding null checks for a state that's unreachable, "fixing" an API misuse that was correct. Each fake fix is a fresh opportunity for a real bug, and the loop diverges instead of converging.

So every finding goes through a **verifier** stage before anything acts on it: a separate agent whose only job is to reproduce the finding or kill it. Write the failing test that demonstrates the bug. Trace the actual code path. Produce the input that triggers the race. No reproduction, no forward — the finding dies in triage. Evidence or it didn't happen applies symmetrically: it governs the critics exactly as it governs the builder.

## 4. Loop until dry

Single-pass review systematically undercounts, and the undercount is weirdly consistent: models converge on ten to twenty findings and stop, regardless of how many exist (F6). That number is a training prior, not a measurement of your code. It's the answer to "about how many findings does a code review have?" — not to "how many problems are in this diff?"

The defense exploits sampling diversity (E1): re-run the fan-out with *fresh* contexts, and the new pass surfaces findings the first one didn't — different samples, different blind spots. Repeat until **two consecutive passes produce zero verified findings**. Dry, twice. That's the exit condition, and it's an exit condition based on measurement rather than on the model's opinion of its own thoroughness.

With a budget cap — and this part matters: **a prosecution loop that won't converge is information, not under-iteration.** Hit the max-round budget without drying out and the correct move is to stop and escalate, because the loop is telling you the spec is contradictory or the partition is wrong. More iterations launder that signal into cost.

One demotion to record, because the branding around multi-vendor review oversells it: cross-*model* prosecution (a GPT-family model reviewing Claude-family work, or vice versa) is a real but third-order improvement. Different training data, different blind spots — worth having. But the active ingredients are fresh context and the refute charter, in that order. Teams blocked from multi-vendor access lose a few points of recall. Teams that cross-model with a *shared* context lose everything, because they kept the costume and discarded the mechanism.

## Who reviews the reviewer?

Everything above sounds rigorous. Here's the embarrassing question: **what's your review stack's recall?**

Not vibes — the number. Of the real bugs in a typical diff, what fraction does your prosecution stack actually catch? Which categories does it miss? Did last month's model upgrade silently change the answer?

Nearly every team running agentic review today trusts the stack blind. Findings come back, findings look plausible, findings get fixed, everyone feels reviewed. Whether the stack catches 85% of real bugs or 40% is — for almost everyone — unknown and unasked. And recall varies silently with everything: per repo, per language, per charter wording, per model version. A model upgrade that improves code generation can *degrade* review recall in specific categories, and nothing in your pipeline will tell you.

The fix is the same trick mutation testing plays on test suites, aimed one level up: **plant known bugs, measure what comes back.**

`npx review-calibration` does this mechanically:

1. Take a real merged diff from your repo's history — real code, real style, real noise.
2. Plant N realistic bugs in it: mechanical mutation operators plus LLM-authored subtle ones, spread across categories — off-by-one, auth bypass, race condition, contract violation, error-swallowing.
3. Run your full prosecution stack (ours is `npx adversarial-review`) against the planted diff, exactly as it runs in CI.
4. Score recall and false-positive rate against the known plant list, per category.
5. Exit 2 if recall falls below threshold.

The output turns "we do adversarial review" from a vibe into a number — and the per-category breakdown is where the action is. Low recall on races means you add a dedicated concurrency lens. Low recall on auth means the security charter needs sharpening. Re-run on every model change, and the silent regressions everyone currently absorbs unknowingly become diffs in a dashboard.

### What planted bugs look like

Calibration is only as honest as its plants. Mechanical mutants are necessary but not sufficient — a prosecution stack can learn to catch operator-swaps while staying blind to semantic rot. The subtle tier is LLM-authored: single-line edits, plausible at a glance, each producing a real behavioral bug. Here's the kind of plant that tier produces — an example drawn from this toolkit's own code, in — of all places — the hash-chain verifier of the provenance tool:

```diff
- if (entry.prev !== expected) {
+ if (entry.prev && entry.prev !== expected) {
```

One added truthiness guard. The chain verifier now silently *skips* verification for any entry missing its `prev` link — which means an attacker (or a confused agent) can break the evidence chain by omitting a field, and the verifier reports the chain valid. It survives casual reading because `x && x !== y` is a common defensive idiom; here the "defense" is the bug. Plants in the same vein: a `Math.max` over conflict signals demoted to `Math.min` (the forecast now reports the *least* alarming signal), a global regex flag dropped from a dedupe normalizer (only the first match normalized, duplicates leak through), `!==` weakened to `<` in a length comparison (reordered-but-same-length changes pass as identical).

Every one of these is one line. Every one is a real bug. A review stack's recall against this tier is the honest measure of what it would catch in your next real diff — and the first calibration run tends to be a humbling experience.

The meta-point: this is **measurement replacing trust**, the same move the whole lifecycle keeps making. Don't ask the reviewer if it's thorough (introspection — the thing models are worst at). Plant bugs and count (measurement — the thing arithmetic is best at). The calibration score even travels with the verdicts it qualifies: a review verdict means more when it carries the measured recall of the stack that produced it, so the score goes into the merge's evidence manifest alongside the test hashes and the rails-diff proof.

## The gate

Prosecution's exit gate, in full: **zero verified open findings, two consecutive dry passes, rails still green, and the rails diff is empty** — that last item being the mechanical proof, promised in post 3, that the builder never touched its own gates.

What passes through this gate has been built inside frozen rails, prosecuted by calibrated fresh-context critics until dry, with every finding reproduced or killed. That's one ticket. One lane.

The obvious next question is throughput: if one agent inside this structure is reliable, why not five at once? Because parallel agents that share state produce merge hell, contract drift, and integration bugs — *unless* the partition is clean, and partition quality turns out to be measurable before you pay for the fan-out. Parallelism has exactly three dials, and the central fact about them is that they're not independent.

*Next: [Three Dials: Parallel Agents Without Merge Hell →](./05-three-dials-parallel-agents.md)*
