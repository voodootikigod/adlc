# Design — Cross-model gate: close manifest TRUNCATION via an opt-in attestation-store anchor

**Status:** Design (brainstorming output, approved by Chris Williams → ticket T149 authored →
P1 interrogation next).
**Date:** 2026-07-28
**Author:** Chris Williams (@voodootikigodcom), drafted with Claude Code
**Scope:** `packages/prosecute/` (new library + CLI flag), this repo's own
`.github/workflows/cross-model-gate.yml`, and documentation. **Opt-in hardening mode for this
repo's own dogfooding — not a required capability for other ADLC adopters.**

> Related: GitHub issue #355, follow-up to PR #354 (merged, squash `14250e1`). Ticket **T149**
> in the canonical ticket store carries the same content as the executable contract.

---

## Problem

PR #354 hardened the cross-model attestation gate against **forgery** (an attacker cannot mint
a fake distinct-provider approval — signatures cover the entry) and **rewrite** (an attacker
cannot reorder or edit an existing signed entry in place — `manifestChainTrustworthy()` verifies
the chain). It left one gap open: **truncation**.

An author who controls the PR branch can drop a signed `needs-attention` revocation entirely,
leaving a valid (shorter) signed chain that ends in an earlier genuine `approve`. Because:

- `revisionIgnorePaths()` (`packages/prosecute/lib/run.mjs:32`) excludes manifest paths from the
  revision hash, editing/truncating `.adlc/manifest.jsonl` does not change the reviewed revision
  — the earlier approve still matches.
- Making the gate a required check does not help — it evaluates the attacker's truncated tree.
- Base-anchoring cannot see it — the revocation only ever existed on the PR branch, post-divergence
  from `main`.

Signatures bind `seq`, `ts`, `prev`, and `data` (including `revision`) —
`canonicalEntryBytes` (`packages/gate-manifest/lib/sign.mjs:41`) — so an attacker cannot forge a
replacement entry or relabel a dropped revocation's revision. The **only** residual attack is
deleting a whole line. Closing it requires memory of an attestation that lives **outside** the
attacker-controlled branch, recorded at the moment a trusted CI run first observes it.

## Non-goals

- **Not a new required ADLC capability.** The library and CLI flag are backward-compatible and
  inert unless explicitly invoked; the workflow wiring touches only this repo's own
  `cross-model-gate.yml`, which — unlike `docs/ci/rails-guard.yml`, `docs/ci/adversarial-review.yml`,
  and `docs/ci/adlc-maintenance.yml` — has never been a distributed template other repos copy.
- **Not solving revision-binding scope** (#365, tracked separately in ticket
  `t-gate-revision-binding`) — a different, unrelated gap in the same gate family.
- **Not implementing orphan-branch pruning/rotation.** Unbounded growth of `adlc-attestations` is
  accepted and documented as a future YAGNI.
- **Not automating ruleset deployment.** The GitHub ruleset on `adlc-attestations` is a one-time
  manual setup step, documented but not scripted by this change.

## Why this is worth the complexity (and why it's opt-in)

This closes one narrow residual gap at the end of an otherwise-closed hardening chain, and it
only has teeth when the cross-model gate is a **required** status check *and* the PR author is
not fully trusted — i.e., exactly the case where the independent-review guarantee needs to survive
an adversarial author. In a single-maintainer or fully-trusted-contributor repo this buys very
little, since that person has cheaper ways to bypass a gate entirely. The realizable gain is the
compliance-shaped guarantee ("prove independent review happened and prove it can't be silently
erased") that matters for external/enterprise adopters — but critically, **this repo dogfoods it
without forcing that cost onto anyone else**: the mechanism ships as inert-by-default library code,
and the only opinionated wiring lives in a workflow file that was never shipped as a template.

## Design

### 1. Store: protected-ref mirror

New orphan branch **`adlc-attestations`** in this repo, holding one append-only file
**`attestations.jsonl`**. Each line is the verbatim signed manifest entry observed for the
`cross-model-review` gate by the trusted CI workflow. A GitHub repository ruleset protects the
branch; its bypass list contains only the GitHub Actions app — chosen over a scoped fine-grained
PAT because this is a single dogfood repo, and a new secret to provision and rotate isn't worth
the marginal isolation gain.

### 2. Library — `packages/prosecute/lib/attestation-store.mjs` (new, pure, DI'd)

- `readObservedAttestations(storePath, { key })` → signature-verified cross-model entries read
  from the store; a missing file returns an empty list (bootstrap case — must not throw).
- `assertNoTruncation({ prEntries, observedEntries, revision, key })` → pure function. For the
  given `revision`, the set of observed entries' signatures must be a subset of the PR's currently
  valid entries' signatures for that revision; a violation returns/throws the missing signatures
  for a precise, actionable fail-closed message. Revision is signature-covered, so an attacker
  cannot relabel a dropped revocation's revision to dodge the check.
- `mirrorObservedAttestations({ prEntries, storePath, key })` → appends every valid cross-model
  entry from `prEntries` not already present in the store (dedup by signature); returns the count
  newly appended. Must be tmpdir-testable — no dependency on a real git checkout.

### 3. Gate wiring

`hasCrossModelApproveForRevision` (`packages/prosecute/lib/cross-model.mjs`) gains an **optional**
`observedEntries` parameter.

- **Present:** run `assertNoTruncation` first; any missing signature fails the gate closed before
  the existing `crossModelSatisfied` evaluation runs.
- **Absent:** behavior is byte-for-byte identical to today (#354). Every existing caller that
  omits the parameter must see no change at all — this is the backward-compatibility contract the
  opt-in framing depends on.

### 4. CLI

`packages/prosecute/bin/adlc-prosecute.mjs`:

- `tier-check` gains an optional `--attestation-store <path>` flag. Omitting it preserves current
  behavior exactly.
- New `mirror-attestations` subcommand: reads the PR-side manifest entries, calls
  `mirrorObservedAttestations` against a given store path, reports the count appended.

### 5. Workflow — `.github/workflows/cross-model-gate.yml` only

Job order:

1. Fetch `adlc-attestations` into `./_attestations` (branch absent → empty store, bootstrap).
2. Run `mirror-attestations` (base-controlled binary; PR tree is materialized as data only, never
   executed, per the existing `./_pr` pattern) to append the PR's new valid attestations.
3. `git commit && push` the updated store to `adlc-attestations`.
4. Only then run the gate: `tier-check --attestation-store ./_attestations/attestations.jsonl ...`.

Hard requirements:

- `permissions: contents: write` — justified because it's base code only, the payload is
  signature-verified entries, the push target is the orphan branch, and `main` stays
  ruleset-protected.
- `concurrency: { group: <per-PR>, cancel-in-progress: false }` — serializes runs so a
  revocation's mirror step completes and is pushed before the next push's gate run is evaluated.
  Without this, a fast double-push could race the mirror and let one truncation through.
- A failed mirror-push step **fails the job** — never evaluate the gate against a store update
  that didn't actually land.

### 6. Documented residual limit

A revocation is protected only once it has been **observed** by a trusted CI run — pushed to the
PR and the gate workflow ran at least once before truncation. A recorded-but-never-pushed
revocation is invisible to everyone, the same exposure as an unsubmitted review. This is strictly
better than today, not a claim of completeness, and is stated plainly in the docs.

## Known overlap risk

PR #375 (branch `fix/370-unsigned-attestation`, open as of this writing) also edits
`packages/prosecute/bin/adlc-prosecute.mjs` (the `record-cross-model` handler) and its CLI test
files. Whichever branch merges second must rebase and manually re-check for conflicts in these
files — no assumption of a clean auto-merge.

## Testing

- **Required:** `approve → revoke → truncate` fail-closed test — build a signed chain with an
  `approve` then a `needs-attention` revocation for the same revision, mirror both into a fixture
  store, truncate the manifest (drop the revocation line, keep the shorter chain validly signed),
  assert the gate now **fails** where #354 alone would have passed.
- `assertNoTruncation` unit tests: subset passes; missing-sig fails; revision-scoped; relabel
  attempt fails.
- Mirror idempotency/dedup; empty/absent-store bootstrap.
- `tier-check --attestation-store` CLI integration test (clean-pass, bootstrap, truncation-fails).
- No-regression test: calling `hasCrossModelApproveForRevision`/`tier-check` **without** the new
  parameter/flag is unchanged from current behavior.
- Workflow structural check (inspection): mirror-before-gate ordering, `contents: write`,
  `concurrency` with `cancel-in-progress: false`, mirror failure fails the job.
- `/adlc:adlc-prosecute` (P5), including the cross-model-review gate itself (this change touches
  `packages/prosecute/`, trust-root tier). Given the new `contents: write` surface, run
  `npx adversarial-review --base main` with a provider distinct from whoever records the
  cross-model approve.

## Documentation updates

- `manifestChainTrustworthy()`'s comment and the workflow's comments (both currently name #355 as
  the open follow-up) — update to reflect the closed state.
- A README or ADR note stating plainly: opt-in, not required for ADLC adopters; the "protected
  only once observed" residual limit; the one-time manual ruleset-deploy step.

## Open questions — resolved

- **(a) Store shape:** orphan branch `adlc-attestations` + single `attestations.jsonl`. Chosen over
  a custom `refs/adlc/*` ref because GitHub rulesets target `refs/heads/*` natively.
- **(b) Write path:** default `GITHUB_TOKEN` + ruleset bypass (GitHub Actions app in the bypass
  list). Chosen over a scoped fine-grained PAT — for a single dogfood repo, a new secret to
  provision and rotate isn't worth the marginal isolation gain.
- **(c) Scope:** flipped mid-brainstorming from "ship as default behavior" to **opt-in hardening
  mode, this repo only** — see [Why this is worth the complexity](#why-this-is-worth-the-complexity-and-why-its-opt-in).
