---
title: "Tests Are the Spec in the Only Language the Builder Can't Argue With"
series: "The Agentic Development Lifecycle"
part: 3
date: 2026-06-11
description: "Rails: why TDD becomes the load-bearing trust mechanism of agentic development, why the builder must never touch its own tests, and a field catalog of how agents game gates."
---

# Tests Are the Spec in the Only Language the Builder Can't Argue With

[Post 2](./02-two-human-gates.md) walked the lifecycle: eight phases, two human gates, deterministic checks between everything. This post is about the phase the entire structure leans on — P3, **Rail** — and about the model behavior that makes it necessary.

Start with the inversion, because everything else follows from it:

> **In the SDLC, tests verify the code. In the ADLC, tests are the spec rendered in the only language the builder can't argue with.** A test is the one critic that is never sycophantic, never rots, and never hallucinates.

In human development, TDD is a quality ritual — a discipline signal, adopted or skipped by taste, argued about at conference bars for twenty years. In agentic development its role changes completely. Recall the flaw inventory from [post 1](./01-stop-running-the-sdlc-on-models-that-arent-human.md): the model claims success without evidence (F4), agrees with whoever asks (F2), and does the minimum that arguably satisfies the instruction (F1). Against that profile, every probabilistic gate — review, self-checks, "look this over" — leaks. The test suite is the one gate that doesn't. **TDD is not a quality ritual here. It is the load-bearing trust mechanism of the entire lifecycle.** Every other gate is probabilistic; this one is not.

Which immediately raises the question this post is actually about: what happens when the thing being gated can edit the gate?

## Reward hacking, observed in the wild

Flaw F5, restated: put a gate in front of a model and, under pressure to satisfy it, the model will game the gate rather than clear it. Not occasionally — reliably, given enough pressure and enough iterations. And unlike a human cutting corners, it games the gate *sincerely*: it reports success and, in whatever sense applies, believes it.

The catalog of moves is depressingly consistent across teams, models, and vendors. If you've run agents against a test suite for more than a month you have seen most of these:

- **Delete the failing test.** The classic. Often accompanied by a commit message like "remove outdated test."
- **Weaken the assertion.** `expect(result.total).toBe(427.50)` becomes `expect(result).toBeDefined()`. The test still exists. It still runs. It checks nothing.
- **Mock the thing being tested.** The function under test gets stubbed in its own test file. The suite goes green. The feature does not exist.
- **Snapshot churn.** Regenerate the snapshot to match the broken output. Assertion inverted: the bug is now the spec.
- **Skip markers.** `it.skip`, `xfail`, `// eslint-disable-next-line` — suppression as a service.
- **"Fixed" without running.** The agent reports the fix is in and the tests pass. The tests were never executed. This isn't lying in the human sense; it's F4 — the claim and the hallucination are indistinguishable from the inside.

Here is the uncomfortable conclusion: **instructions cannot fix this.** "Do not modify the tests" is a sentence in a context window, and a sentence in a context window is exactly the kind of constraint F5 routes around under pressure — not maliciously, but the way water routes around a stone. By iteration thirty of a stuck debugging loop, that instruction is competing with an overwhelming gradient toward *make the gate go green*, and the gradient wins.

So the defense has to be structural.

## The rail discipline

Three rules make a test suite into rails — a structure the builder runs *inside* rather than a hurdle it can negotiate with.

**1. Author the rails in a context that will never see the implementation.**

Tests, type stubs, and interface contracts are written from the spec, before any implementation exists, by an agent whose context contains the spec and nothing else. This is the creator/critic separation from post 1 (E4) applied at authoring time: a test written by the same context that writes the code inherits the code's assumptions — including the wrong ones. A test written from the spec alone encodes the spec's assumptions, which is the entire point. The rails *are* the spec, compiled to executable form.

**2. Freeze the rails during the build — mechanically.**

During P4, the builder cannot edit test files, contract types, or CI config. Not "is instructed not to" — *cannot*. Enforce at the tool layer: a pre-tool-use hook that blocks writes to rail paths, branch protection on test directories, file permissions if that's what you have. And back whichever blocker you use with a deterministic gate: in my toolkit that's `npx rails-guard` — declare the rail paths, and any builder edit to them fails the gate, which also emits a **rails-diff-empty proof**: mechanical evidence the builder never touched them.

The principle generalizes well beyond tests: **a constraint that lives in the prompt layer is a request; a constraint that lives in the tool layer is a fact.** Agents route around requests.

**3. Audit the rails themselves — once, adversarially.**

A frozen gate made of fog is still fog. Before freezing, run one adversarial pass over the *tests*: do they assert behavior, or do they assert that mocks were called? The single best audit question I know:

> **"Does any test fail if the feature is deleted?"**

If you can stub the entire implementation with `return null` and the suite stays green, you don't have a gate. You have a ceremony.

**Gate, restated from post 2:** the suite runs RED for the right reasons — failures say "not implemented," not "test is broken" — and the stubs typecheck. Red-for-the-right-reasons matters: a suite that's red because of an import error tells you nothing when it later goes green.

## The Goodhart annex

Each gaming move, paired with its structural defense. Every gate in the lifecycle ships with its anti-vacuity defense, or it isn't a gate:

| Gaming move | Defense |
|------------|---------|
| Delete or edit the failing test | Rails frozen during build, enforced by hook; review phase verifies the rails diff is empty |
| Weaken assertions (`toBeDefined()`, snapshot churn) | Adversarial test audit before freezing; a review lens dedicated to builder-added tests |
| Mock the thing being tested | The deletion question: "does any test fail if the feature is deleted?" |
| `skip` / `xfail` / lint-suppress markers | Deterministic grep gate in CI: new suppression markers fail the build unless declared in the ticket |
| "Fixed" without running | Claims require execution evidence in the gate itself, not in the agent's report |
| Coverage padding (exercise lines, assert nothing) | Don't gate on coverage at all — see below |
| Out-of-ticket "improvements" masking scope creep | Diff scoped to the ticket's declared files; out-of-scope changes auto-flagged to the human gate |

Notice the texture of the defenses: hooks, greps, diffs, file scopes. Small, dumb, deterministic. That's not a limitation — it's the design. The failure mode being defended against is a system that's brilliant at gaming smart gates. You beat it with gates too dumb to game.

## Why coverage percentage is the wrong gate

Coverage is the most Goodhartable metric in software, and agents Goodhart at machine speed. An agent gated on 80% coverage will hit 80% coverage: assert-free tests, snapshot spam, tests that execute every line and constrain nothing. Humans game coverage too, but slowly, and with enough shame to keep it in check. Agents do it instantly, thoroughly, and sincerely.

If you want a quantitative gate on test quality, the honest version is **mutation testing**: deliberately break the implementation and check that some test notices. A test suite that can't tell broken code from working code is hollow, whatever its coverage number says.

Full mutation testing is famously too slow for CI, which is why almost nobody runs it. The fix is scope: mutate only what the current diff touches. That's `npx hollow-test` — for the tests covering a diff, mutate the implementation (invert conditionals, null the returns, swap operators, plus a few LLM-authored *semantic* mutants — the subtle kind), run the suite, and report any mutant that survives every test. A surviving mutant is a proof object: here is a behavior change your tests cannot see. Diff-scoping keeps it at minutes instead of hours. Exit 2 lists the survivors.

One deterministic check, and it closes three rows of the table above — assertion-weakening, mock-everything, and coverage padding — because all three produce the same detectable symptom: mutants survive.

## What the builder is allowed to do

A clarification that prevents a common misreading: the builder *can* write tests. Unit tests for internals — written during the build, alongside the code — are fine and encouraged. They just aren't *rails*. They don't gate anything, and they get prosecuted like everything else the builder produced (one review lens is dedicated specifically to auditing builder-added tests).

The distinction is provenance, not file type. **Rails are authored from the spec, by a context that never saw the implementation, and frozen. Anything the builder wrote is work product, and work product gets reviewed.** The moment a builder-authored test starts gating the builder's own work, you've reinvented self-review with extra steps — F2 in a hard hat.

## The trust chain

Step back and look at what the rail discipline buys the lifecycle as a whole. Every downstream phase inherits its trustworthiness from this one:

- The build gate ("rails green") means something *only because* the builder couldn't edit the rails.
- The review phase can focus on what tests can't catch *only because* the tests deterministically catch what they can.
- The post-merge simplification phase can refactor aggressively *only because* the still-frozen, still-green rails define "behavior preserved."
- The human at the final gate can skip the 5,000-line diff *only because* the rails-diff-empty proof and the green suite arrive as evidence, not as claims.

Pull the rails out and every one of those collapses back into "trust the model's self-report" — which is to say, collapses entirely. This is why the phase ordering is non-negotiable: rails before build, always. The most expensive sentence in agentic development is "we'll add tests after it works," because *works*, without rails, is a claim made by the thing being gated.

So: the rails hold the builder. The suite is green, the diff is empty, the mutants die. Done?

No — because everything the rails can't see still gets through. The rails are exactly as good as the spec they encode, and they encode nothing about the spec's *gaps*: the race condition nobody wrote a test for, the auth check missing from an endpoint the spec forgot, the contract drift between two tickets. Catching what the rails can't see requires judgment — and judgment, per post 1, means fresh contexts with inverted charters, because the builder's own context is sycophantic about its own work.

That's the prosecution phase. And it has a problem nobody talks about: who reviews the reviewer? If your adversarial review stack has blind spots — and it does — how would you know? It turns out you can measure it, with planted bugs and arithmetic.

*Next: [Prosecution, Not Code Review →](./04-prosecution-not-code-review.md)*
