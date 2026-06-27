# Spec — Risk-tiered multi-model adversarial review (ADLC P5)

**Phase:** P1 working spec for ADR-0007. Deliverable of this ticket is the **design**
(this spec + ADR-0007). The `adversarial-review` skill enhancement it specifies is a
follow-on build (separate repo: `voodootikigod/adversarial-review`); its acceptance
criteria are captured here so the build is executable without re-deriving the design.

## Goal

Make **reviewer diversity** a first-class, risk-gated part of the ADLC's adversarial
review surface. Today the `adversarial-review` skill already prefers a *single*
provider different from the builder. This spec elevates that to: for high-blast-radius
changes, require an independent verdict from **≥2 distinct providers**, and treat a
single clean approve as **advisory, not a gate-pass** — because providers have
different blind spots.

## Motivating evidence (the Cursor case study)

On the ADLC Cursor integration (PR #40), a same-model (Claude) P5 prosecution passed;
a cross-model **Codex/GPT** `adversarial-review` loop then ran **18 rounds** to a
zero-finding `approve`; a third model, **Gemini 3.1 Pro**, then found a **high-severity**
multi-root relative-path rail bypass GPT had missed, plus a follow-on flaw in the fix.
A single model's clean approve was demonstrably **not proof**. Diversity — not count —
was the load-bearing variable.

## Scope of the policy (when ≥2 providers are REQUIRED)

Mirror the `model-router` (D1) risk tiers. A change qualifies as **high-blast-radius**
(needs ≥2 distinct providers) if it touches any of: authentication / authorization /
trust boundaries; a security control or deny path (rail guards, validators); secrets
handling; data-loss / destructive / irreversible operations; schema or migration
changes; CI/CD or supply-chain config. Everything else defaults to **single
cross-model** review (today's behavior). Trivial / non-security changes may skip.

## The `adversarial-review` enhancement (`--providers`)

A new multi-provider mode, distinct from the existing `--passes` (which samples ONE
model N times and so adds no provider diversity):

1. `--providers <a,b[,c]>` — run the same review prompt against each named provider
   (API key or local CLI), independently.
2. **Merge + dedup** all providers' findings into one report, keyed by
   (file, line range, category/title); a finding raised by multiple providers is
   marked with its corroborating providers.
3. **Quorum-aware verdict** — `needs-attention` if ANY provider returns a material
   finding (at/above the `--fail-on` threshold); `approve` only if ALL selected
   providers approve. `--quorum <n>` may relax this deliberately.
4. **Distinct-family auto-selection** — when `--providers` is omitted but multi-model
   is requested (or the risk tier demands it), auto-select ≥2 providers from
   *different* families (never the builder's family twice).
5. **No silent downgrade** — if fewer than the requested providers are reachable, run
   what is available AND emit a loud notice that multi-provider was requested but
   under-satisfied (so a degraded run can't masquerade as a full one).

## Evidence-driven, not dogmatic

Tie the requirement to `review-calibration` (P5, "who reviews the reviewer"): a
*measured* low single-model mutant-catch recall on the repo is what should trigger the
second provider, so multi-model is applied where it demonstrably adds recall rather
than as blanket ceremony. The ADR records this as the principled escalation lever.

## Out of scope (note in ADR)
Building the skill enhancement (separate repo); a mechanical P5-entry enforcement in
`coldstart`/router (defer, exactly as ADR-0005 deferred its P2 enforcement); paid
auto-provisioning of provider keys.

## Acceptance criteria (each has a concrete verification method)

- **AC1** — ADR-0007 exists with a `Status` line (Accepted), references the Cursor case
  study and `review-calibration`, and includes a cost / diminishing-returns caveat. *Verify:* run `grep -nE 'Status|review-calibration|Cursor|diminishing' docs/adr/0007-multimodel-adversarial-review.md` and confirm all four appear.

- **AC2** — ADR-0007 defines the risk tiers (`trust boundary`, `deny path`, auth, data-loss, CI/CD) requiring ≥2 distinct providers and states a single approve is advisory for those tiers. *Verify:* `grep -nE 'trust boundary|deny path|advisory' docs/adr/0007-multimodel-adversarial-review.md` and confirm the tiers + "advisory" appear.

- **AC3** — This spec passes spec-lint with zero wishes. *Verify:* run `adlc spec-lint docs/specs/multimodel-review.md` and assert exit 0.

- **AC4** (follow-on build) — `adversarial-review --providers gpt,gemini` runs the
  prompt against BOTH providers independently. *Verify:* a unit test stubs two providers and asserts each is invoked once with the same prompt; assert exit 0.

- **AC5** (follow-on build) — findings from multiple providers are merged and deduped by `(file, line, category)` with corroboration recorded. *Verify:* a unit test feeds two provider outputs sharing one finding and each having one unique finding, and asserts the merged report has exactly three findings with the shared one tagged by both providers.

- **AC6** (follow-on build) — the verdict is quorum-aware: one `approve` + one
  `needs-attention` yields exit 2 by default. *Verify:* a unit test with those two stubbed verdicts asserts the merged exit code is 2 unless `--quorum` overrides.

- **AC7** (follow-on build) — requesting multi-provider with only one reachable provider runs single-provider AND emits an under-satisfied `notice` (no silent downgrade). *Verify:* a unit test with one available provider asserts a warning line is emitted and exit reflects the single-provider result.

Suppressions are denied.
