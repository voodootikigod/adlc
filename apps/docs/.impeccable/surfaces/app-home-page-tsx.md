---
version: 1
slug: "app-home-page-tsx"
primary_target: "app/(home)/page.tsx"
related_targets: ["app/(home)/lifecycle/page.tsx","app/(home)/failure-modes/page.tsx","app/(home)/vs-sdlc/page.tsx","app/(home)/toolkit/page.tsx","app/(home)/integrations/page.tsx","app/(home)/enterprise/page.tsx"]
---

## Scope and mode

The marketing routes: `/`, `/lifecycle`, `/failure-modes`, `/vs-sdlc`, `/toolkit`,
`/integrations`, `/enterprise`. Mode is **Persuade**. `/docs` (Fumadocs) is out of
scope and inherits tokens only; it keeps the dark reading surface.

## Audience, job, action

Two audiences, neither a funnel stage for the other. The hands-on engineer
evaluates by installing and getting a gate to run against their own repository.
The engineering leader evaluates whether the process is defensible — whether
there is an audit trail a non-engineer could read. Success is an install, not a
lead.

## Proof on hand

The toolkit itself (26 gate CLIs, 7 harness integrations, real commands and real
exit codes), dogfooding in this repository's own CI, and two public testimonials
from one person. No case studies, customers, logos, benchmarks, or time-saved
figures exist, and none may be invented. One testimonial's legacy-project caveat
must never be clipped.

## Chosen direction — The Change Record

Seed key `54a31abe`, scope `direction`, mode `persuade`, re-roll round 1,
assigned index 3 of the grounded list. Composition A of three rendered comps,
approved by the user.

The controlled-change record: what changed, why, who assessed impact, what the
back-out is, who approved, and what evidence was attached. It is the artifact
that makes a change defensible rather than merely done, which is the question
the leadership buyer has about agents. Rendered in its contemporary enterprise
register — the controlled form as a screen — never its rubber-stamp nostalgia.

**The surface inversion is the argument.** The record reads as a governed
document on cool paper; the evidence stays true An Old Hope terminal on
`#1c1d21`. Human-readable record, machine-produced proof. Approved explicitly by
the user against the alternative of staying dark throughout.

## Memorable moment

Every claim carries a numbered exhibit, and the exhibit is real CLI output with
a real exit code. A sentence with no exhibit reference has no standing, which
turns "demonstrate rather than assert" from a principle being honored into
grammar the page cannot violate.

## Craft bar

User-named, on the record: enterprise platform (Datadog, Snowflake, Databricks)
and security/compliance (Vanta, Wiz, 1Password). The second group is the closer
match — they sell attestation and audit trails to the same accountable buyer.

## Rejected, and why (do not re-propose)

Round 0 dealt "The Bench" (instrument panels) and "The Departure Board"
(split-flap). Both refused by the user as too whimsical for an audience of
enterprise engineers and the leadership accountable for what agents merge. The
underlying flaw was in the derivation: five of seven grounded candidates were
industrial-instrumentation objects, one material family wearing seven hats.
Charm is the failure mode to avoid here.

## Constraints that outrank taste

- Palette "An Old Hope" is pinned by PRODUCT.md. It pins the palette, not how
  boldly it is used.
- Green pass / red fail / amber human gate, and verdicts never carried by colour
  alone — a glyph pairs with a word (`✓ PASS` / `✗ FAIL`).
- Motion respects `prefers-reduced-motion`.
- Command literals import from `lib/install-commands.mjs`; never hand-typed.
- Install renders before the first content section.
- Windows is unsupported and must not be softened to "beta" or "experimental".

## Approved comp

`apps/docs/.impeccable/mocks/comp-a-record-header.html`

Comps B (chain-led) and C (pinned claim/exhibit split) were rendered and not
chosen. C's pinned evidence panel remains a candidate for `/lifecycle`.

## Must not be literalized from the comp

The record number `ADLC-CR-0001` and its field values are framing, not claims.
The comp's four-column field block, its exact type sizes, and its two-exhibit
tail are a direction test, not a spec. Responsive behavior, focus states, and
interaction states were not resolved in the comp and are implementation
responsibilities.

## Unresolved

Whether `/docs` eventually follows the record world or stays a dark reading
surface. Deferred deliberately — redesigning Fumadocs is a separate piece of
work.
