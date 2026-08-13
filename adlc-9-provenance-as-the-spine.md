# Provenance Is the Spine You Never Named

*The Agentic Development Lifecycle, part 9*

Eight posts in, the lifecycle has a shape you can draw: eight phases, two human
gates, a deterministic checkpoint between every pair of machine steps. That shape
is right. But it's the skeleton drawn from the outside — the sequence you'd narrate
watching work move from spec to merge. It isn't the load-bearing member. Underneath
the phases there's a single beam every one of them was bolted to, and the series
described it in eight different vocabularies without once giving it a name.

The beam is **provenance**: for every artifact that influences a decision, an
unforgeable answer to *who produced this, from what inputs, and verified how* — and
a gate is nothing more than a place that refuses to advance an artifact whose
provenance doesn't check out.

This post doesn't retract a word of the first eight. It names the thing they were
all defending.

## Say it back to the earlier posts

Read the series again with the word in hand and it stops being a set of independent
mechanisms and becomes one mechanism applied eight times.

The flaw inventory (part 1) was a taxonomy of provenance attacks all along:

| Model flaw | What it actually is | The defense, renamed |
|---|---|---|
| **F2 Sycophancy** | Forging the critic's provenance — the builder's context signs off on the builder's work | Never let an artifact carry provenance its own author produced |
| **F4 Hallucination** | Claiming provenance for work that never ran — "I fixed it" with no execution behind the claim | *Evidence or it didn't happen*: a claim has no provenance until something deterministic reproduced it |
| **F5 Reward hacking** | Laundering a red state into a green attestation — delete the test, keep the pass | Gates must verify the *substance* an attestation points to, not the attestation |
| **F3 Context rot** | Provenance of *judgment* decaying as context fills; the reviewer's verdict inherits the builder's history | Fresh context per task — clean-provenance judgment |

"Tests are the spec" (part 3) is a provenance statement: a rail is an acceptance
criterion authored in a clean context and made immutable, so its provenance can
never be re-signed by the party it judges. "Prosecution, not code review" (part 4)
is provenance hygiene: the critic must not inherit the builder's provenance, and a
finding is a claim until it carries reproduction provenance of its own. Even "two
human gates" (part 2) is a provenance claim wearing a scheduling costume — those two
gates are the two roots that must be anchored to a *human* identity no agent can
mint, because everything downstream inherits its trust from them.

And the toolkit (part 7) buried the lede. `gate-manifest` was listed fourteenth of
eighteen and captioned "cross-cutting provenance," as if it were a peer of
`spec-lint` and `behavior-diff`. It isn't a peer. It's the substrate the other
seventeen stand on — the signed chain that lets a verdict produced in one context be
trusted in another without trusting the party that produced it — which holds only as far as each
attestation is bound to the immutable identity of what it certifies (the exact commit,
not merely "a run that passed"), or a green verdict from one change replays onto the
next. The tools aren't a flat list of phase-enforcers. They're producers and consumers of provenance-bearing
artifacts moving along one signed chain.

## Where this lands, precisely

Say the reframing plainly, then bound it, because an elegant frame that swallows
everything is how a true idea becomes a wrong one.

**The phases are the transport layer.** P0 through P7 are how a
provenance-bearing artifact moves from intent to merged change. The phase boundaries
matter because that's where provenance is *checked* — a deterministic gate is a
provenance checkpoint, and the reason an LLM→LLM handoff without one multiplies error
is that it's a handoff with no verifiable chain of custody.

**The model failures are attempts to forge or launder custody.** Every one of the
trust flaws is a way to make an artifact *look* like it has provenance it doesn't:
sign your own work, claim a fix you didn't run, pass a check by gaming its
observable instead of satisfying its intent.

**The defenses are custody integrity.** Fresh contexts, refute charters, frozen
rails, execution-witnessed findings, signed manifests — every strong part of the
lifecycle is a measure to keep provenance unforgeable across a boundary.

Now the bound. **Provenance is the spine of the *trust* architecture — not of the
whole skeleton.** It explains what makes the lifecycle *dependable*. It does not
explain what makes it *affordable*, and those are different loads carried by
different bones. Premature satisfaction (F1) is a *completeness* failure, not a
forgery. Generative bloat (F7) is an *economy* failure. The three dials of part 5
and the cheaper-every-run curve of part 6 are cost-asymmetry arguments that would
be true even if forgery were impossible.

So the honest structure is two spines, not one:

- **Provenance** — unforgeable custody of every decision-bearing artifact. The
  reason you can *trust* a lifecycle where a model wrote most of the diff.
- **Cost-asymmetry** — exploration, review, and regeneration approach free relative
  to human time, so you spend heavily at the ends and thin in the middle. The reason
  you can *afford* to.

The series led with the second spine in its titles — "gets cheaper," "three dials,"
"prosecution" as an economic reallocation of judgment. It left the first spine
implicit, doing the actual load-bearing while the economics took the marquee. Part 9
is just this: the trust leg has a name now.

## Why naming it earns its keep

A frame is worth adopting only if it makes something that was scattered become one
thing. This one does, and the proof is a review of this very codebase.

Audited against its own doctrine, the toolkit's serious findings looked like eight
unrelated bugs across CI config, hook resolution, phase runners, and integrations.
Under the provenance lens they are one bug with four faces:

- **Fail-closed gates that no required check enforces** — the gate produces a
  correct DENY verdict with *no binding provenance to the merge it should block*.
  The custody chain ends in mid-air.
- **Human gates nothing anchors to a human** — acceptance provenance an agent can
  mint. The root of the chain is forgeable.
- **A signing key reachable by the builder's context** — anyone can forge the
  attestation the whole chain's trust derives from. The private key of the lifecycle
  left on the porch.
- **Verdicts that are model prose, not executed proof** — a finding "verified"
  with no reproduction provenance behind the word.

Four leaks, one pipe. That's what a spine buys you: the failures stop being a list
and start being a *property* — *is custody unforgeable end to end?* — that you can
audit as a single question. It also tells you where to build next. The lifecycle has
a tool that red-teams a gate's *reasoning* (`gate-fuzzing`); the provenance lens says
the missing sibling is a tool that verifies a gate's *custody* — that every declared
gate is actually binding and every root is actually anchored. Same instinct, one
layer down.

## The design rule

Every post in this series has left one. Here is part 9's, and it's the sibling of
part 2's *evidence or it didn't happen*:

> **No artifact crosses a gate on its own say-so.** Anything that influences a
> decision — a spec approval, a frozen rail, a review finding, a merge verdict, a
> behavioral acceptance — must carry provenance a *different party* can verify
> without trusting its author. If the only thing vouching for an artifact is the
> party that produced it, it has no provenance, and the gate must treat it as absent.

"Evidence or it didn't happen" was this rule aimed at the builder. This is the same
rule aimed at *everything* — the critic, the human, the gate itself. A verdict is an
artifact. An approval is an artifact. The key that signs them is the most
consequential artifact in the system, and it has provenance too: whoever can reach
it can forge everything downstream.

## The meta-proof, and the road

The last thing worth saying is that the lens predicts its own defense. In the course
of reviewing this work, a document was submitted with a note appended for the
reviewer — text asserting the document lay outside what was being examined, and
instructing how its findings should be read. The reviewer flagged it, correctly, as an
attempt to launder the document's provenance: an author vouching for its own
trustworthiness in language aimed at the party meant to verify it independently. The
system caught a provenance forgery in the act of writing a post about provenance.
That is not a coincidence. It's the spine doing the one thing a spine does.

Which points at the work. If provenance is the trust leg, then the trust-root layer
deserves to be a *pillar* of the lifecycle, not a caption on one tool: every
artifact provenance-stamped at birth, every gate a custody check, every root — the
signing key, the human gates, the required-check wiring — treated as the crown
jewels they are, because the entire chain inherits its trust from them. Build the
phases well and you have a lifecycle that *moves* correctly. Build the provenance
spine well and you have one you can *trust*. You need both legs to stand.

---

*Next: the trust-root layer as a first-class pillar — provenance stamping, custody
checks at every gate, and treating roots as crown jewels.*
