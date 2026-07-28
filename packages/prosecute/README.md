# @adlc/prosecute

> **Design decision: this is a recorder, not a reviewer.** `@adlc/prosecute` makes zero
> model calls and runs no adversarial review of its own. It is a P5 evidence ledger: it
> validates, hashes, and appends normalized reviewer-produced pass records to
> `.adlc/manifest.jsonl`. The actual model-judged review is a separate tool -- run
> `npx adversarial-review` (or `adlc review`, which passes args through to it) -- and feed
> **its** output into `prosecute` as the `--input` evidence. If you run `adlc prosecute`
> expecting it to find bugs, it will not; it only proves that a real review already did.

P5 review-evidence recorder. It consumes normalized reviewer-produced pass evidence,
records ticket- and revision-scoped P5 evidence to `.adlc/manifest.jsonl`, and passes
only after two consecutive dry passes with at least three distinct dry lenses.

## Usage

```sh
adlc-prosecute --input p5-passes.json --ticket T1 --dir .adlc --json
```

## Input shape

```json
{
  "target": "feature branch",
  "provenance": {
      "reviewer": "local-reviewer",
      "session": "codex-session-123",
      "command": "npx adversarial-review --scope working-tree --include-files",
      "transcript": ".omo/evidence/p5-review.txt"
  },
  "review_packet": {
      "prompt": ".omo/evidence/p5-prompt.txt",
      "prompt_hash": "sha256-of-prompt-file",
      "inputs": ".omo/evidence/p5-inputs.txt",
      "inputs_hash": "sha256-of-reviewed-input-packet",
      "clean_worktree": "git-worktree:..."
  },
  "passes": [
    {
      "lens": "security",
      "findings": [
        {
          "id": "F1",
          "severity": "high",
          "category": "security",
          "file": "src/auth.js",
          "line_start": 10,
          "line_end": 12,
          "evidence": "quoted changed code",
          "claim": "token bypass",
          "recommendation": "validate issuer",
          "confidence": 0.8,
          "verified_status": "verified"
        }
      ]
    },
    {
      "lens": "security",
      "findings": [],
      "dry_evidence": "review transcript reports no verified security findings"
    },
    {
      "lens": "correctness",
      "findings": [],
      "dry_evidence": "review transcript reports no verified correctness findings"
    }
  ]
}
```

`verified_status` must be `verified`, `killed`, or `needs-human`. Killed findings must
include `verification.reason`, `verification.method`, and `verification.evidence`.
Inputs must use the built-in lens names: `security`, `correctness`, `tests`, `behavior`,
`integration`, or `docs`. Clean reviews with zero finding candidates are accepted when the
dry passes include evidence. If no finding is marked `verified`, the input must include
`no_findings_attestation` with
`reason`, `method`, and `evidence`. Only passes with zero findings count as dry; killed
findings are recorded but do not advance dry-pass convergence.

The transcript is not treated as a generic attachment. It must be readable, at least 64
bytes, and it must reference both the `--ticket` value and the resolved reviewed revision
string (`git-worktree:<hash>` unless `--revision` is supplied). This binds the recorded
P5 evidence to the ticket and revision that P6 later checks, but it still does not prove
that an external reviewer ran. Use the named `provenance.command` and transcript from the
actual skeptical review run, not a hand-written placeholder.

The review packet binds the reviewer prompt and reviewed input packet to P5 evidence.
`prompt` and `inputs` are file paths, their hashes must match the supplied SHA-256 values,
and `clean_worktree` must equal the exact reviewed revision.

**Evidence file location is enforced, not just convention.** If `provenance.transcript`,
`review_packet.prompt`, or `review_packet.inputs` resolves to a path *inside* the worktree,
it must live under `.adlc/` or `.omo/evidence/` -- `lib/run.mjs`'s `isEvidencePath()` rejects
any other in-worktree location. This is a trust-boundary control: it stops review "evidence"
from pointing at an arbitrary file elsewhere in the repo that could be edited to fake a
clean review. `.omo/evidence/` is otherwise-gitignored scratch space, but the three files
backing the bundled example (`docs/examples/p5-passes.json`) are deliberately carved out
of that ignore rule and tracked -- see the comment in `.gitignore` before treating anything
under `.omo/` as safe to delete.

## Trust-root tier — required cross-model review (T39)

For the **trust-root tier**, a clean same-model P5 is not sufficient. The CLI computes the
changed-file set from the **WORKING TREE vs `<base>`** (default `--base main`) — the two-dot
`git diff --name-only <base>` (tracked changes incl. uncommitted) unioned with untracked,
non-ignored files (`git ls-files --others --exclude-standard`) — and classifies it with
`lib/tier.mjs`. Working-tree-inclusive is load-bearing: prosecution binds to the working-tree
revision, so a three-dot `<base>...HEAD` diff (committed only) would miss an **uncommitted**
edit to a trust-root file and let a converged P5 exit 0 with no attestation. A change is
trust-root tier iff it touches an enforcement package
(`packages/rails-guard|prosecute|gate-manifest|build-gate/`), a gated-artifact producer
(`packages/ticket-prune|ticket-sync/`), a declared rails deny-path of any ticket, or a
trust-root file (`scripts/rails-guard-ci.mjs`, `docs/ci/rails-guard.yml`,
`scripts/test/rails-guard-workflow-hashes.json`, `.adlc/tickets.json`). The ticket table for
rails-deny-path tiering is read from the **same `--dir`** the prosecution uses (falling back
to `.adlc/tickets.json`), so rails declared under a custom `--dir` are not invisible to the
tier. For such a change, a passing P5 **additionally** requires a `cross-model-review`
**`approve`** in the manifest whose `provider` is distinct from the author and whose
`revision` equals the reviewed revision. Missing → exit 2.

**Author identity is anchored to the prosecution run.** A tiered run MUST declare the author
via `--author-provider <p>` (or `ADLC_AUTHOR_PROVIDER`); distinctness is measured against
*that* prosecution-declared author, not the entry's self-reported `authorProvider` (an
attestation defines both sides, so comparing only its own fields is forgeable). The gate also
requires the record to have been made for that author context. A tiered run with **no**
author-provider **fails closed** (exit 1) — distinctness cannot be proven without knowing the
author.

**Fail-closed on an unresolvable base.** Tiering needs the base ref to compute the diff. If
`<base>` cannot be resolved (e.g. a shallow CI checkout with no `main`), the CLI **refuses
the run with exit 1** rather than silently skipping the cross-model requirement — a silent
ungated pass is the fail-open class this gate exists to prevent. **CI must provide the
base** (fetch it, e.g. `git fetch --no-tags origin main`, or pass an explicit `--base
<ref>`). Hermetic unit runs that assert convergence only (not tiering) pass `--base HEAD`
so, from a **clean committed** worktree, the working-tree diff is empty and the tier gate
stays off (run such checks post-commit; uncommitted trust-root edits deliberately tier).

Record the attestation (after an actual cross-model review approves) with:

```
ADLC_MANIFEST_KEY=<key> adlc prosecute record-cross-model --ticket <id> \
  --provider <p> --author-provider <a> --verdict approve [--input <passes.json>] [--revision <r>]
```

**Recording requires the signing key (#370).** The gate trusts an attestation only via its
HMAC signature, so an unsigned entry is inert. Without `ADLC_MANIFEST_KEY` the command
therefore **fails closed** — exit 1, nothing written, and a message naming the consequence —
rather than writing an unsigned entry and reporting success. That old behaviour cost the
operator a full distinct-provider review before CI revealed the attestation was worthless,
and the entry was permanent: the manifest is append-only and hash-chained. Note the key is
commonly kept in a gitignored `.env.local` in the **main checkout**, which is absent from
every git worktree; `record-cross-model` reads it from `./.env.local` (never `tier-check` —
see `lib/load-env-local.mjs`), so from a worktree source it explicitly.

Writing an unsigned entry on purpose — #326's forge-resistance test does, to prove the gate
rejects one — needs the explicit `--allow-unsigned`. An unsigned write never prints the
success line; it prints a warning naming the consequence instead. `--json` reports
`"signed": true|false` alongside the recorded entry either way.

It resolves the revision the same way the gate does (`resolveProsecutionRevision`), so pass
the same `--input`/`--revision` you use for the gate run. `--provider` must differ from
`--author-provider` — a same-model attestation is refused at record time and rejected by the
gate (`lib/cross-model.mjs`, fail-closed). Like rails-guard this cannot prove a model ran; the
author identity now comes from the prosecution invocation (not a self-report), and the record
is an auditable, revision-bound, append-only, distinct-provider, author-anchored entry. See
[ADR-0007](../../docs/adr/0007-multimodel-adversarial-review.md).

## Truncation anti-rollback anchor (opt-in, #355)

**This is a hardening mode for this repo's own dogfooding. It is NOT a required ADLC
capability — no adopter needs or is expected to use it.**

The cross-model gate above closes **forgery** (signatures cover the entry) and **rewrite**
(the hash chain + per-entry signature reject an edited-in-place line) — see the HONEST LIMIT
comment in `lib/cross-model.mjs`. One gap remained: an author who controls the PR branch can
**truncate** the manifest, dropping a signed `needs-attention` revocation entirely and leaving
a valid, shorter, validly-signed chain ending in an earlier genuine `approve`. Because the
revision hash excludes manifest paths (so recording an attestation doesn't change what it's
attesting to), the dropped revocation is invisible to a required check alone — it evaluates
only the truncated tree.

`lib/attestation-store.mjs` closes it with a protected-ref mirror: an orphan branch
(`adlc-attestations`, ruleset-protected — see
`docs/github-rulesets/adlc-attestations-ruleset.json`) holds every signed cross-model entry a
trusted CI run has ever observed, appended by the new `mirror-attestations` subcommand. `tier-check`
gains an optional `--attestation-store <path>` flag; when passed, a signed entry the store has
seen that is missing from the PR's own manifest fails the gate closed with a distinct
"ROLLBACK/TRUNCATION DETECTED" message (separate from "no attestation" and "chain broken").
**Omitting the flag reproduces today's behavior exactly** — this is why the mechanism is
opt-in rather than baked into the shared library's default path. Only this repo's own
`.github/workflows/cross-model-gate.yml` is wired to use it (that workflow has never been a
distributed template, unlike `docs/ci/*.yml`).

**Documented residual limit**: a revocation is protected only once a trusted CI run has
observed it (pushed to the PR and the workflow ran at least once before truncation). A
recorded-but-never-pushed revocation is invisible to everyone — the same exposure as an
unsubmitted review. This is strictly better than the forgery/rewrite-only gate above, not a
claim of completeness.

**A tampered or key-rotated store entry FAILS CLOSED, not silently ignored.** `readObservedAttestations`
and `mirrorObservedAttestations` both throw if any store entry's signature does not verify —
this is either an `ADLC_MANIFEST_KEY` rotation (every historical store entry needs migrating
onto the new key, the same treatment the main manifest chain already requires) or tampering by
whoever has bypass-level write access to `adlc-attestations`. Rotating the signing key is
therefore a migration event for this store too: rebootstrap or re-sign it, don't expect
`tier-check --attestation-store` to keep working across a rotation without that step.

**Observed entries are scoped by `(revision, authorProvider)`, not by PR/branch identity — deliberately.**
Two different PRs that coincidentally produce a byte-identical reviewed change (same base, same
diff — a duplicate branch, for instance) share observed-entry history, so a revocation mirrored
from one can block the other. This is intentional, not a gap: `revision` (the change-set identity
from #365) already means "the identity of the reviewed change," and #365's own carry-forward
feature treats an identical change-set digest as grounds to carry a verdict *forward*. Treating an
identical digest as grounds to carry a *revocation* forward too is the symmetric, consistent
consequence — adding a PR-unique discriminator to avoid this would let an attacker dodge a revoked
review by opening a new PR with byte-identical content. See
[the design doc](../../docs/superpowers/specs/2026-07-28-cross-model-truncation-anchor-design.md)
for the full threat model, the premortem/parallax findings that shaped the final design, and
why the store path must live outside the tree being tiered.

## Exit codes

- `0`: two consecutive dry passes were recorded (or a finding/attestation was recorded)
- `1`: operational error
- `2`: verified/needs-human findings remain, the convergence budget ended before two dry
  passes, a trust-root-tier change lacks a matching cross-model attestation, or (with
  `--attestation-store`) a rollback/truncation was detected

## Core gaps

This package records cross-model attestations through `@adlc/gate-manifest`'s chained
`record()` (see `lib/cross-model.mjs`) and reads them back via `@adlc/core`'s `readEntries`.
The trust-root-tier classifier (`lib/tier.mjs`) lives here rather than in `@adlc/core`
(frozen) because it is prosecute-specific policy; if a second package ever needs the same
binary trust-root decision, the enumerated surfaces (enforcement packages, producers,
trust-root files) would ideally graduate into `@adlc/core` alongside the existing
`railpath`/`risk-tier` helpers so the list has a single source of truth.

## ADLC phase

P5 Prosecute. This tool makes the review-evidence and dry-pass record executable, but
the reviewer command named in `provenance.command` remains the source of the review.
