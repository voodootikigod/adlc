---
title: "The Gates Didn't Hold"
series: "The Agentic Development Lifecycle"
part: 9
date: 2026-06-11
description: "We aimed the lifecycle's own prosecution at the toolkit that enforces it. Every gate with an adversarial surface green-passed input it was built to stop — and that failure, reproduced and fixed, is the realer proof-of-work than the one we shipped."
---

# The Gates Didn't Hold

[Post 7](./07-we-built-the-toolkit-with-the-lifecycle.md) ended the doctrine with a tidy line: the toolkit was built by the lifecycle, and then "aimed at itself." That sentence was doing a lot of work it hadn't earned. So we aimed it for real — fresh contexts, refute charters, the lifecycle's own [prosecution phase](./04-prosecution-not-code-review.md) pointed at the gates themselves, with one question per gate: *what is the strongest reason this does not hold?*

It went badly, which is the point. Nearly every gate with an adversarial surface green-passed the exact input it existed to stop. The proof-of-work this series actually deserved was never "we built eighteen clean tools." It's this: the process caught its own builder's blind spots, on the author's own code, with a trail you can reproduce. A victory lap proves nothing a skeptic believes. A reproduced failure does.

## The shape of the blindness

The findings rhymed. Every gate had been built to catch an *honest mistake* — a typo'd path, a forgotten assertion, a malformed file — and every one folded the instant the operator was *lazy or adversarial*. Which is the whole problem, because [the doctrine's threat model is an adversarial builder](./03-tests-are-the-spec.md): a model under gate pressure deletes the failing test, weakens the assertion, mocks the dependency, and reports all green, sincerely. The toolkit's gates had quietly reverted to the SDLC's cooperative-operator assumption — the exact assumption [post 1](./01-stop-running-the-sdlc-on-models-that-arent-human.md) said to throw out.

There's a reason it reverted, and it's the most uncomfortable line in the series to write about your own code. The builder that wrote each gate also wrote that gate's tests, in the same context. So the gate and its tests inherited the *same blind spot*. The suite was green because it asserted against the inputs the builder imagined — never the input the builder couldn't imagine, which is precisely the one an attacker reaches for. This is [Principle 3](./04-prosecution-not-code-review.md) — *never judge work your own context produced* — playing out one level up, in the tooling built to enforce Principle 3. A fresh context with a refute charter is the only thing that sees it, because a fresh context is the only thing the construction history hasn't already biased.

Three of them, named, because [vague claims get the vague treatment](./03-tests-are-the-spec.md) and we're not doing that here.

### `rails-guard` — the freeze a `git commit` walks through

The rail freeze is the load-bearing trust anchor of the entire lifecycle: the builder cannot edit its own tests, contracts, or CI config during the build. Post 7's table says `rails-guard` "blocks builder edits." It does not block — it *detects*, after the fact, by diffing the working tree. And it diffed against the wrong thing: the default base was `HEAD`, and `git diff HEAD` cannot see a change that has already been committed.

So the attack is one command. Edit the frozen test, `git commit` it, run the gate:

```
$ rails-guard --rails 'test/**'
rails-guard: all checks passed      # exit 0
```

Reproduced in a scratch repo, start to finish. The builder edits its own acceptance test, commits, and the freeze gate — the one mechanism in the system that was supposed to be *non-probabilistic*, the one every other gate's trust hangs on — reports clean and, with `--record`, writes a signed-looking "rails-diff-empty proof" attesting to it. The gate didn't just miss the edit. It manufactured evidence that no edit occurred.

### `gate-manifest` — provenance you can forge from scratch

`gate-manifest` is sold as the evidence chain: "every gate appends a *signed* entry," in-toto/SLSA for agentic provenance, the thing that lets a regulated org prove agent-written code was verified. There was no signing. Each entry's link to the previous one was a plain `sha256` of the prior line — a public, keyless function. Anyone who can write the file can recompute the entire chain.

A prosecutor wrote a clean two-entry chain by hand — `tests-pass`, then `prosecution-clean: SHIP` — recomputing each hash, and asked the tool to verify it:

```
{ "valid": true, "count": 2 }
```

No gate ever ran. The provenance tool certified a merge that never happened. The chain caught an honest actor who edited one line and forgot to recompute forward; against anyone who runs the tool, it proved nothing.

### `review-calibration` — the honesty meter that lied, and froze the lie into a test

This is the one that should sting, because `review-calibration` is the meta-gate: it measures whether your prosecution stack is honest by planting bugs and counting what comes back. It scored a plant as "caught" if the review output mentioned the right line — or merely *contained a twelve-character substring of the changed line*. A reviewer that echoes every changed line and understands nothing scores **recall 1.0**. The instrument that certifies your reviewer is trustworthy was itself gameable by a `cat` command.

And its own test suite asserted the echoing reviewer *passes* — the bug wasn't just present, it was frozen into a green test as the intended behavior. The calibrator had been calibrated to call dishonesty honest.

The broader sweep found the same disease in eight more places: a P2 gate that trusted an environment variable for its verdict, a mutation tester that marked every mutant "killed" when the test command was simply `false`, a conflict forecaster that reported a cyclic dependency graph as a clean empty schedule, a session supervisor blind to the one log format that actually exists, a behavioral diff that passed a dead server as "unchanged." Eleven gates, one failure class.

## The turn: reproduced, then RED

Two things made this a proof instead of an LLM grumbling about code.

First, **every finding was reproduced, not asserted** — the doctrine's "[evidence or it didn't happen](./04-prosecution-not-code-review.md)" turned back on the toolkit. The `rails-guard` bypass ran in a shell to exit 0. The `gate-manifest` chain was forged and verified. The echoing reviewer was scored at 1.0. A finding nobody can reproduce is noise that burns fix-agent tokens chasing ghosts; we let none through.

Second, **each fix started from the reproduction as a failing test**. `rails-guard` now resolves its baseline to the merge-base with the trunk and *fails closed* when it can't — a committed rail edit is caught, and the test that proves it is the bypass itself, inverted. `gate-manifest` gained real keyed signing; the forged chain that used to verify `valid` now fails. `review-calibration` was rebuilt to score a plant as caught only when a finding *locates and identifies* it — verified behaviorally or judged semantically, with no substring shortcut — and the echoing-reviewer test was flipped: it now asserts recall **~0**. That inverted test became the control that runs on *every* calibration from here on. The bug that hid in a green assertion is now the assertion that guards against its own return.

The trail is real and ordinary: a frozen-baseline fix to the shared core, a sweep across eleven gates, the calibrator's rebuild — landed as commits, each carrying the regression test that reproduces its exploit, roughly eighty new tests across the toolkit, every package green. Not a narrative. A diff.

## Why this is the proof, not the embarrassment

The series keeps making one move — [replace trust with structure, structure with measurement](./07-we-built-the-toolkit-with-the-lifecycle.md) — and this episode is that move applied to the toolkit itself, which means it's the doctrine's own claims, tested on the doctrine's own artifacts:

- **F2 — self-review is worthless.** The builder's green suite certified gates the builder couldn't see were broken. Asking the toolkit "do you look right?" returned yes, exactly as predicted.
- **E4 — fresh context has an inverse value.** The only reviewer that found the blindness was one with no stake in the code being right and no memory of why it was written that way. Contamination by construction history is real; the cure is a context that lacks it.
- **The recursion closes.** We calibrated the calibrator: the tool that measures reviewer honesty was made honest by the same trick it performs on everyone else — plant the failure, measure, gate. Dogfooding usually means "we used our own product." Here it means our own product diagnosed our own product, and the diagnosis was *you are sick*.

The honest boundaries, because a doctrine without them is marketing — and because this post, like every gate, deserves its own prosecution:

The prosecutors were agents under one operator's direction, same model vendor. The active ingredient was not cross-vendor independence — it was [fresh context plus a refute charter](./04-prosecution-not-code-review.md), and a human deciding what to reproduce. "Independent review" oversells it; "a critic with no construction-history bias and a charter to break things" is the accurate claim, and it was enough.

And the gates are *hardened against this class*, not *proven correct*. Eleven holes found and closed is not eleven holes that existed; it's the eleven a few prosecution passes surfaced. The next class is already visible: nobody ran a generator whose entire charter is "produce a diff that passes every gate and is wrong," run continuously against the gate suite like a fuzzer for the lifecycle. That tool — call it gate-fuzzing — is the one that finds the holes a fixed review pass won't, and it's the next thing to build, because the lesson of this episode is that a gate you haven't tried to defeat is a gate you haven't tested.

That's the real shape of dogfooding. Not "we ate our own cooking and it was delicious." We ate it, it made us sick, the kitchen's own instruments told us exactly why — and now the test for that sickness runs on every meal.

## Try it on your own gates

You have gates too — the lint config nobody audits, the CI check that's green for reasons no one has verified, the review bot whose recall is unknown. Point a fresh-context, refute-chartered pass at one of them and ask the only question that matters: *what is the strongest reason this does not hold?* Reproduce whatever comes back before you believe it, and turn each reproduction into the test that was missing. The first time is reliably humbling. It is also the cheapest review you will ever run, and the only one that tells you what your gates are actually worth.

*Start of series: [Stop Running the SDLC on Models That Aren't Human →](./01-stop-running-the-sdlc-on-models-that-arent-human.md)*
