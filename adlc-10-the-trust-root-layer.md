# The Trust-Root Layer: Defend the Roots, Not the Chain

*The Agentic Development Lifecycle, part 10*

Part 9 named the spine: provenance, the unforgeable custody of every
decision-bearing artifact, is what lets you trust a lifecycle where a model wrote
most of the diff. It ended on a promise — that the roots of that custody deserve to
be a *pillar* of the lifecycle, not a caption on one tool. This post is that pillar,
and it starts with the uncomfortable observation that made it necessary.

**Attackers don't break your chain of custody. They forge a root.**

A signed chain is easy to reason about and easy to feel good about. Each link points
at the last, each verdict carries a hash, the whole thing validates end to end. And
none of it means anything if the first link — the key that signs, the human who
approves, the config that binds a verdict to a merge — can be produced by the party
the chain is meant to hold accountable. You can build flawless custody checks at
every gate and be totally compromised, because trust in a chain doesn't accumulate
from the links. It descends from the roots.

Which is why the roots, not the gates, are the real trust boundary of the system.

## The census that finds the compromise

Audit this lifecycle's own toolkit against its own doctrine and the serious findings
were, without exception, root forgeries — not one was a flaw in a gate's reasoning.
The gates reason correctly. The roots were exposed. Here is the census that makes
that legible, and it is the single most useful artifact in this post: enumerate
every root, name the write-boundary that protects it, and state what a forgery buys
the attacker.

| Root | What it anchors | Anchored in a layer the builder can't write? | If forged |
|---|---|---|---|
| **Signing key** | Every manifest attestation | Only if it lives *outside* the builder's reach (CI secret, `pull_request_target` with base code) | Forge any verdict; the whole chain is theater |
| **Human identity** at P1/P6 | The two non-machine trust roots | Only if bound to an identity provider outside the repo | An agent mints its own spec approval and behavioral acceptance |
| **Required-check wiring** | The binding from a gate's DENY to the merge it blocks | Only if set in platform branch protection, outside the PR | Every fail-closed gate becomes advisory; DENY still merges |
| **Frozen rails** | The spec the builder is judged against | Only if read from the base ref, never from HEAD | The builder re-signs its own acceptance criteria |
| **The guard code itself** | The custody checks | Only if the guards are inside their own protected set | Edit the check, own everything downstream |

Read the third column top to bottom. That column *is* the security model. Every row
where you can't fill it in confidently is a root sitting on the porch. In the audit,
the key was reachable in-session, the human gates were unbound, the required checks
were unwired, and — the only rows done right — the rails were base-anchored and the
guard code froze itself. Two anchored, three exposed. The chain was immaculate; the
roots were the whole problem.

## The invariant, stated once

Every row's third column is the same sentence wearing different clothes, and it is
the load-bearing rule of the entire trust architecture:

> **A root is trustworthy only if it is anchored in a layer the party under review
> cannot write.** Custody is unforgeable exactly when it bottoms out in a
> write-boundary the builder is *outside* of — a CI secret it can't read, a base ref
> it can't rewrite, a branch protection it can't reconfigure, an identity it can't
> assume. Provenance that bottoms out inside the builder's own reach is not
> provenance. It's decoration.

This is why the toolkit's few genuinely sound roots are sound. The key isolation
runs base code against the PR tree as *data* under `pull_request_target` — a mechanism
infamous for leaking privilege the instant base code executes anything a contributor
supplied, and safe here only because it is fenced with the mitigations that footgun
demands: no contributor code runs, credentials are withheld until after install, and
install scripts are disabled. That it takes that much care to make one root safe is not
a caveat to the argument; it *is* the argument. The rails read `completed`, contracts, and
manifest from the base ref, so a PR can't self-unfreeze by editing the ticket store
in the same change. The guard freezes `rails-guard/lib/ci/**` as a directory glob, so
a new enforcement file is protected the moment it's added. Each one works for the
same reason: the thing the attacker would need to write lives on the far side of a
boundary the attacker is outside of.

An anchored root carries a cost the exposed kind doesn't: you have to be able to
*update* it without unanchoring it. A guard that freezes its own directory has to
answer how a legitimate fix to that guard ever lands — and the only honest answer is
that a change to a root is itself a rooted operation, gated by the same out-of-band
authority that protects the root: multi-party sign-off, a key the builder can't reach,
an approval anchored outside the change under review. A break-glass path that lives
inside the builder's reach isn't break-glass. It's the unanchored override the whole
layer exists to eliminate, wearing an emergency vest.

## Roots cannot certify themselves

There's a corollary that sounds like a logic puzzle until you watch it get violated.
**A root cannot establish its own trustworthiness**, because "trust me" from the party
under review is precisely the thing a gate exists to reject. When something vouches
for itself in language aimed at the verifier, that isn't provenance — it's the attack.

We watched this happen in part 9: a document that certified its own scope in a note
addressed to its reviewer, caught on the spot as a forged root. The lesson
generalizes well past prompt injection. Any root that can only be trusted because it
*says* it should be trusted is not anchored — and anchoring always comes from
*outside*: a different party, a lower layer, a boundary the author can't cross.

## The one root that rots

Four of the five roots have a clean binary integrity: the key is secret or it isn't,
the wiring is set or it isn't, the rails are base-anchored or they aren't. The human
root is different, and it's the one most likely to fail quietly. A human gate can be
**present but hollow** — the approver clicks through without looking, because the
better the machine-checked middle gets, the less the human believes their two gates
matter. Crypto roots fail by exposure. The human root fails by *atrophy*.

So the human root needs a property the others don't: liveness. The same discipline
the toolkit already applies to its automated reviewers — planting known bugs to
measure whether the review actually catches them — the human gate needs pointed at
itself. Surface the handful of things most likely to be wrong instead of a wall of
green. Occasionally route a change with a known, *contained* defect to the human gate
and measure whether it gets caught — contained doing real work in that sentence,
because a liveness probe that can reach production when the human misses it isn't a
test of the gate, it's the failure the gate exists to prevent. A human gate you never
test is a root you're *assuming* is
anchored, and an unmeasured assumption is exactly what the doctrine forbids
everywhere else. The human is a root; treat their attention as an artifact whose
provenance you verify, not one you take on faith.

## Trust concentrates — and that's the good news

The barbell showed up first in economics: spend heavily at the ends of the lifecycle,
thin in the middle. The trust-root layer is the same shape for a different quantity.
You cannot harden everything, and the relief of this frame is that you don't have to.
Trust concentrates in a handful of roots — five, in this system — and everything else
in the lifecycle *inherits* its trustworthiness from them through custody checks. So
the defensive investment concentrates too: make the roots unforgeable *absolutely*,
and let the propagation do the rest. A hundred gates guarding a forgeable key is worse
than five gates guarding an anchored one, because the second system has a defensible
boundary and the first only looks like it does.

That is what promoting provenance to a pillar actually buys you: not more machinery,
but a smaller, namable set of things that must be perfect, and a test — the census —
that tells you the day one of them slips.

None of this is the operating manual, and it shouldn't be mistaken for one. Naming a
root is not running one. A signing key is a whole lifecycle — generation, rotation,
revocation, and the bootstrapping ceremony that establishes the first root before any
chain exists to vouch for it. A CI runner is a machine that can be contaminated
between jobs. A break-glass path is a governance process with its own quorum. Each of
those is the substance of *building* the trust-root layer, and each is its own
document. The claim here is narrower and prior to all of them: until you can name
every root and the boundary that anchors it, no amount of key hygiene or runner
hardening matters, because you don't yet know what you're protecting. The census comes
first. The ceremonies come after.

## The design rule

> **Enumerate your roots, and for each name the write-boundary that anchors it. If
> you cannot name one, it is not a root — it is a liability, and the gate that
> depends on it is advisory no matter what its exit code says.** Defend the roots
> like crown jewels, because the chain already defends itself; the roots are the
> only place an attacker can still win.

## Where this leaves the lifecycle

Draw the lifecycle now and it isn't a row of eight phases anymore. It's eight phases
riding on two spines and a floor. The economics spine decides where you spend. The
provenance spine decides what you can trust. And beneath both runs the trust-root
layer: a small, anchored set of roots — key, human, wiring, rails, guard — that every
gate reads from and every custody check descends to.

Build the phases well and work moves correctly. Build the provenance spine well and
you can trust what moves. Build the trust-root layer well — anchor every root outside
the reach of the party it holds accountable, and audit it with a census you can run
in an afternoon — and the whole structure stops being a set of hopeful mechanisms and
becomes a system whose trust you can point at, name, and prove.

The chain was never the hard part. The roots always were.
