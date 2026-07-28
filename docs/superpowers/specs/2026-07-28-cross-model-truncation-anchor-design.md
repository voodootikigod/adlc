# Design — Cross-model gate: close manifest TRUNCATION via an opt-in attestation-store anchor

**Status:** P1 interrogation complete — `spec-lint` clean (8/8 verified, no vacuous methods),
`premortem` recorded (gate-manifest seq=101), `parallax` divergence pass recorded (seq=102, 5
ambiguities found and resolved below + mirrored into ticket T150). Next: P2 decompose
(`model-router`/`merge-forecast`) or straight to TDD implementation.
**Date:** 2026-07-28
**Author:** Chris Williams (@voodootikigodcom), drafted with Claude Code
**Scope:** `packages/prosecute/` (new library + CLI flag), this repo's own
`.github/workflows/cross-model-gate.yml`, and documentation. **Opt-in hardening mode for this
repo's own dogfooding — not a required capability for other ADLC adopters.**

> Related: GitHub issue #355, follow-up to PR #354 (merged, squash `14250e1`). Ticket **T150**
> in the canonical ticket store carries the same content as the executable contract. (Originally
> authored as T149; renumbered during a rebase onto origin/main after an independent, unrelated
> ticket claimed T149 first — see #383.)

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

Five ambiguities below were surfaced by a `parallax` divergence pass and are resolved explicitly
(not left to whoever implements) — see [Resolved ambiguities](#resolved-ambiguities-parallax-pass).

- `readObservedAttestations(storePath, { key })` → `storePath` is the direct path to the
  `attestations.jsonl` FILE (not its containing directory). Re-verifies every entry's signature
  against `key` on every read — the store is defense-in-depth storage, not a trust boundary by
  itself, so a corrupted or tampered store file cannot inject a trusted-looking entry merely by
  having been written to disk. A missing file returns an empty list (bootstrap case — must not
  throw).
- `assertNoTruncation({ prEntries, observedEntries, revision, key })` → pure function; **never
  throws**. Returns `{ ok: true }` or `{ ok: false, missing: [<sig>, ...] }`. For the given
  `revision`, the set of observed entries' signatures must be a subset of the PR's currently valid
  entries' signatures for that revision; a violation reports the missing signatures for a precise,
  actionable fail-closed message. Revision is signature-covered, so an attacker cannot relabel a
  dropped revocation's revision to dodge the check. Callers (the CLI, `hasCrossModelApproveForRevision`)
  are responsible for turning `ok: false` into a fail-closed outcome (rejected verdict / non-zero exit).
- `mirrorObservedAttestations({ prEntries, storePath, key })` → appends every valid cross-model
  entry from `prEntries` not already present in the store, deduped by the entry's own `sig` field
  (two entries with the same `sig` are byte-identical by construction — the signature covers the
  full canonical entry). Returns the count newly appended. Must be tmpdir-testable — no dependency
  on a real git checkout. `storePath` here is the same direct-file-path convention as above.

### 3. Gate wiring

`hasCrossModelApproveForRevision` (`packages/prosecute/lib/cross-model.mjs`) gains an **optional**
`observedEntries` parameter.

- **Present:** `observedEntries` is first scoped to THIS run's `authorProvider` (normalized
  comparison), then `assertNoTruncation` runs; on `{ ok: false }` the gate itself fails closed
  (rejected verdict / non-zero exit) before the existing `crossModelSatisfied` evaluation runs.
  The author-scoping step is load-bearing, not cosmetic — revision alone is not a safe key,
  since two unrelated PRs from different authors can coincidentally produce an identical tree
  (revision is a pure content hash); without it, an observed revocation from one author's context
  would falsely block a different author's own, legitimate review at the same revision (found by
  cross-model review round 2, see §Cross-model review findings below).
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
- `concurrency: { group: cross-model-gate-${{ github.event.pull_request.number }}, cancel-in-progress: false }`
  — serializes runs **per PR** so a revocation's mirror step completes and is pushed before the
  next push's gate run for the *same PR* is evaluated, while different PRs still run concurrently.
  **Must NOT key on `github.ref`**: under `pull_request_target` that resolves to the *base* ref
  (e.g. `refs/heads/main`), which is identical across every PR — using it would silently collapse
  all PRs into one global serialization queue instead of scoping per PR. Without correct per-PR
  serialization, a fast double-push could race the mirror and let one truncation through.
- A failed mirror-push step **fails the job** — never evaluate the gate against a store update
  that didn't actually land.

### 6. Documented residual limit

A revocation is protected only once it has been **observed** by a trusted CI run — pushed to the
PR and the gate workflow ran at least once before truncation. A recorded-but-never-pushed
revocation is invisible to everyone, the same exposure as an unsubmitted review. This is strictly
better than today, not a claim of completeness, and is stated plainly in the docs.

## Resolved ambiguities (parallax pass)

A `parallax` divergence pass (three independent readings of this spec) found five points where
implementers would plausibly have made different, incompatible choices. Each is resolved above and
restated here for traceability:

1. **`assertNoTruncation`'s failure contract** — never throws; always returns `{ ok, missing? }`.
   The caller decides how to fail closed. (§2)
2. **Store-read trust model** — `readObservedAttestations` re-verifies signatures against `key` on
   every read; the store is not trusted merely for having been written once. (§2)
3. **Mirror dedup key** — the entry's own `sig` field, not a full-string comparison. (§2)
4. **Concurrency group key** — `github.event.pull_request.number`-scoped, explicitly NOT
   `github.ref` (which aliases to the base ref under `pull_request_target` and would collapse all
   PRs into one global queue). (§5)
5. **`storePath` shape** — always a direct file path to `attestations.jsonl`, never a containing
   directory, across the library and the CLI flag. (§2, §4)

## Known overlap risk (resolved)

PR #375 (branch `fix/370-unsigned-attestation`) also edited `packages/prosecute/bin/adlc-prosecute.mjs`
(the `record-cross-model` handler) and its CLI test files, and merged to `main` while this ticket
was still building. Resolved by rebasing (twice — `main` also picked up #377 and #379/#381 in the
same window) and re-recording the P1 premortem/parallax verdicts fresh against each new tip, since
the hash-chained manifest cannot be text-merged. The `bin/adlc-prosecute.mjs` conflict itself was a
small, non-overlapping additive one (`--allow-unsigned` next to `--attestation-store`).

## Cross-model review findings (codex, distinct from the anthropic author)

Six review rounds against the actual diff (round 2 corrected for a stale local `main` ref that
made round 1's diff include unrelated upstream files; round 6 followed #365/#382 merging to
`main` mid-build — see [Interaction with #365](#interaction-with-365-revision-binding) below):

1. **Bootstrap run had no store file to `git add`** — `mirrorObservedAttestations` correctly never
   creates `attestations.jsonl` when there is nothing to append (the right library behavior), but
   the workflow's push step staged it unconditionally. The very first trust-root PR before any
   cross-model attestation has ever been recorded would hard-fail the mirror step instead of
   reaching `tier-check`'s intended "no attestation" message. Fixed: guard `git add` on the file
   existing.
2. **Concurrent PRs could race the shared `adlc-attestations` push** — `concurrency.group` only
   serializes runs for the *same* PR; two different PRs pushing around the same time could hit a
   non-fast-forward rejection with no retry. Fixed: merged mirror+commit+push into one retryable
   cycle that, on a rejected push, resets to the fresh remote tip and re-runs `mirror-attestations`
   from scratch (a clean re-derivation, not a git-level merge of two independent JSONL appends),
   up to 5 attempts before failing closed.
3. **The ruleset's `non_fast_forward` rule didn't actually make the branch append-only** — it only
   blocks force-pushes/history rewrites, not an ordinary fast-forward commit that simply edits
   `attestations.jsonl` to drop a line. Fixed: added the `update` rule, which restricts *all*
   pushes (fast-forward included) to bypass-only actors.
4. **Truncation detection was revision-only, not revision+author** — two unrelated PRs from
   different authors can coincidentally produce an identical tree (revision is a pure content
   hash); an observed revocation from one author's context would falsely block a different
   author's own legitimate review at the same revision. Fixed: `hasCrossModelApproveForRevision`
   now scopes `observedEntries` to the run's `authorProvider` before the truncation check.
5. **`npm ci` ran with a persisted write-capable credential available** — `actions/checkout`
   persists git credentials by default, and this workflow's job now has `contents: write`; a
   compromised transitive dependency's install/postinstall script could have used that ambient
   credential to push a tampered `adlc-attestations` before the mirror/gate steps ever ran. Fixed:
   `persist-credentials: false` on the initial checkout, with the write-capable credential
   configured explicitly (the same header `actions/checkout` installs) in a dedicated step
   immediately before the mirror+push step — well after `npm ci` has already run with none.
6. **`mirror-attestations` wrote to the store before proving the manifest chain trustworthy** —
   each entry's own signature was verified, but a signed entry copied out of context from an
   unrelated, legitimate manifest is individually valid while saying nothing about the CURRENT
   manifest's integrity. Fixed: `mirror-attestations` now calls `manifestChainTrustworthy()`,
   refusing to mirror from an untrustworthy manifest. (An initial fix also re-checked
   `readEntries().skipped`; `mutation-gate` proved that check unreachable — `verify()` already
   returns invalid on the first unparseable line, so it always fails via `manifestChainTrustworthy`
   first. Removed rather than papering over with a test for an impossible state.)
7. **The CLI's diagnostic attribution path re-derived truncation WITHOUT the author scoping** —
   finding 4 fixed `hasCrossModelApproveForRevision`'s enforcement path, but `tier-check`'s separate
   `truncationDetected` computation (used only for choosing which error message/`--json` field to
   show) called `assertNoTruncation` directly with the unscoped `observedEntries`, so the exact
   cross-author revision collision finding 4 closed for enforcement still misreported as
   "ROLLBACK/TRUNCATION DETECTED" in the CLI's attribution message. Fixed by extracting the scoping
   rule into an exported `scopeObservedEntriesToAuthor()` both call sites share, so the two paths
   cannot drift apart again.
8. **A tampered or key-rotated store entry was silently treated as absent** — `readObservedAttestations`
   filtered out any entry whose signature no longer verified, and `mirrorObservedAttestations`'s
   dedup read did the same. A present-but-invalid signature is either an `ADLC_MANIFEST_KEY` rotation
   (every historical entry needs migrating onto the new key, exactly like the main manifest chain
   already requires — see the #364 tests) or tampering by whoever has bypass-level write access to
   the store's branch — silently dropping it would let a truncated revocation go undetected, and a
   stale-but-present `sig` would permanently block a valid re-append via dedup, masking the
   corruption. **This one was a judgment call, not an automatic fix**: the alternative (leave it
   silent) is a strict subset of the already-accepted "bypass scope is repo-wide" residual risk and
   avoids a new failure mode, but the chosen fix — fail closed on both read paths, matching the
   established key-rotation-is-a-migration-event precedent — was confirmed with the repo owner
   before implementing, given it makes ordinary key rotation an operational event requiring an
   explicit store migration/rebootstrap, not something to apply reflexively.

Two findings were surfaced but NOT changed:

- The ruleset's bypass being repo-wide (not scoped to just `cross-model-gate.yml`) was already
  known, documented, and accepted — see the residual-scope note in
  `docs/github-rulesets/README.md`.
- **Round 6**: scoping by `(revision, authorProvider)` means two DIFFERENT PRs that coincidentally
  produce a byte-identical `(base_sha, diff)` — and this repo's workflow always uses
  `authorProvider: anthropic` — would share observed-entry history: a revocation mirrored from one
  PR could block a different PR at the same revision. **Confirmed with the repo owner as
  intentional, not a bug**: #365 (merged mid-build) established that `revision` under the
  change-set scheme IS the identity of "the reviewed change," and #365's own carry-forward feature
  already treats an identical change-set digest as grounds to carry a verdict FORWARD across a
  moved base. Treating an identical digest as grounds to carry a REVOCATION forward too is the
  symmetric, consistent consequence of that same design — not a new gap. Adding a PR-unique
  discriminator to dodge this collision would reopen exactly the evasion this feature exists to
  close: an attacker could sidestep a revoked review by opening a new PR with byte-identical
  content under a different branch name. See
  [the interaction section below](#interaction-with-365-revision-binding) for the full reasoning.

## Interaction with #365 (revision-binding)

PR #382 ("Bind cross-model attestations to the reviewed change, not the whole worktree", #365)
merged into `main` mid-build, replacing the whole-worktree `git-worktree:<hash>` revision identity
with a change-set identity `git-change:<base_sha>:<sha256>` and adding a capped carry-forward
mechanism. It directly touches `packages/prosecute/lib/cross-model.mjs` and
`bin/adlc-prosecute.mjs` — the same two files this ticket built on all session — but
`hasCrossModelApproveForRevision` itself was untouched by #365's diff; the interaction surfaced
only as round-6's scoping question above, not a structural conflict. Rebased cleanly (mostly
additive; the two genuine content conflicts were resolved by hand, see commit history), and the
full #365 test suite (223 prosecute tests) passes unmodified alongside this ticket's own.

## Acceptance criteria

Each has a concrete verification method (this spec must pass `spec-lint`).

- **AC1 — truncation attack closed** — *Verify:* a new `packages/prosecute/test/attestation-store.test.mjs`
  test builds a signed chain (`approve` → `needs-attention` revocation, same revision), mirrors both
  into a fixture store, truncates the manifest (drops the revocation line, keeps the shorter chain
  validly signed), and asserts `hasCrossModelApproveForRevision(..., { observedEntries })` now fails
  closed where #354 alone would have passed.
- **AC2 — no regression to existing callers** — *Verify:* `node --test packages/prosecute/test/` exits 0
  with every existing test file unmodified, and a new assertion calls `hasCrossModelApproveForRevision`
  / `tier-check` WITHOUT `observedEntries`/`--attestation-store` and asserts output identical to
  pre-change behavior.
- **AC3 — `assertNoTruncation` unit-correct** — *Verify:* `packages/prosecute/test/attestation-store.test.mjs`
  asserts (a) a true subset returns `{ ok: true }`, (b) a missing signature returns `{ ok: false,
  missing }` naming it — never throws, (c) per-revision scoping (an unrelated revision's entry
  doesn't block), (d) a relabeled revision still fails (revision is signature-covered).
- **AC4 — mirroring idempotent/bootstrap-safe** — *Verify:* `packages/prosecute/test/attestation-store.test.mjs`
  asserts `mirrorObservedAttestations` run twice appends each signature once, mirroring against a
  non-existent path bootstraps correctly, and `readObservedAttestations` against a missing file
  returns `[]` without throwing.
- **AC5 — CLI integration** — *Verify:* `node --test packages/prosecute/test/prosecute-tier-check-cli.test.mjs`
  covers `tier-check --attestation-store <path>` for clean-pass, missing-store (bootstrap), and
  truncation-fails cases; a companion assertion exercises the `mirror-attestations` subcommand
  end to end.
- **AC6 — workflow structurally sound** — *Verify:* `grep -nE 'mirror-attestations|contents:\s*write|concurrency:' .github/workflows/cross-model-gate.yml`
  shows the mirror step precedes the gate step, `permissions: contents: write` is declared, and a
  `concurrency` block with `cancel-in-progress: false` is present; `grep -n 'continue-on-error' .github/workflows/cross-model-gate.yml`
  returns nothing for the mirror-push step (its failure is never masked); `grep -n 'concurrency' -A2 .github/workflows/cross-model-gate.yml | grep -n 'github.event.pull_request.number'`
  confirms the concurrency group is keyed by PR number, and `grep -n 'group:.*github.ref[^.]' .github/workflows/cross-model-gate.yml`
  returns nothing (the group must not alias to the base ref).
- **AC7 — docs updated and honest** — *Verify:* `grep -rn '#355' packages/prosecute/lib/cross-model.mjs .github/workflows/cross-model-gate.yml`
  no longer names #355 as an open follow-up; `grep -nE 'opt-in|not required' packages/prosecute/README.md`
  (or the new ADR note) confirms the opt-in framing and the "protected only once observed" residual
  limit are documented.
- **AC8 — full gate green** — *Verify:* `npm test` (root) and `npm run preflight` both exit 0,
  `/adlc:adlc-prosecute` passes including a recorded distinct-provider `cross-model-review` approve
  for this trust-root-tier change, and `npx adversarial-review --base main --providers <two distinct>`
  exits 0 (SHIP).

Suppressions are denied.

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
