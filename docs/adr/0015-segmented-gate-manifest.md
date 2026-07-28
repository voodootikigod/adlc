# ADR 0015: Segmented gate-manifest — a chain forest instead of one chain

**Status:** Accepted

**Date:** 2026-07-27

**Decider:** Chris Williams

**Related:** [Segmented gate-manifest spec](../specs/segmented-gate-manifest.md),
[gate-manifest tool](../tools/gate-manifest.md),
[ADR-0010](./0010-sharded-ticket-store.md) (sharded ticket store — the precedent),
[ADR-0014](./0014-track-the-findings-ledger.md) (tracked findings ledger),
cross-model gate hardening #326 and the truncation honest-limit discussion in #354.

## Context

`.adlc/manifest.jsonl` is the C11 evidence ledger: a single, committed, append-only
JSONL file in which every ADLC gate records what it verified. Each entry carries
`seq` (strictly increasing), `prev` (SHA-256 of the previous raw line's exact
bytes), and — when `ADLC_MANIFEST_KEY` is set — an HMAC-SHA256 `sig` whose v2 form
signs every field **including `seq` and `prev`**. All writers funnel through one
locked appender (`@adlc/gate-manifest` `appendManifestEntry`). The rails-guard CI
gate additionally enforces byte-exact append-only against the trusted base
(`assertAppendOnly`).

These properties make merge conflicts structural, not incidental:

- Any two concurrent branches that record evidence both append after the same tail
  line. Git reports a textual conflict on logically unrelated work, every time.
- The conflict cannot be resolved by taking both sides: the later branch's entries
  carry a stale `prev` and duplicate `seq`, so a union produces a chain that
  `verify()` rejects and the cross-model gate fails closed on.
- Because v2 signatures cover `seq` and `prev`, rechaining the losing suffix
  invalidates its HMACs. Only an operator holding `ADLC_MANIFEST_KEY` can repair —
  and the key is deliberately not present in build worktrees.

The cost is recurring and recorded: repeated re-record commits (56de76a, 04bfb7b,
8c0fcdc), two `manifest.jsonl.pre-repair-*.bak` files, and roughly two dozen
manifest-touching commits in a single week. The cost also scales with exactly the
usage ADLC exists to enable — parallel worktree fan-out — because a single linear
ledger is a global serializer.

ADR-0010 solved the same disease for `.adlc/tickets.json` by sharding it into
per-ticket files. The manifest is harder: ticket shards are independent records,
while manifest entries are *linked* — the hash chain and the "a later entry revokes
an earlier one" ordering are the product. Sharding the manifest therefore requires
preserving linkage across files.

Downstream blast radius is bounded: `adlc init` scaffolds `.adlc/*` as gitignored
and does not un-ignore the manifest, so most installs have an untracked manifest
and never see merge conflicts. The repos affected are those that opted into
tracking it (this repository, via `!.adlc/manifest.jsonl`) — but the *format* is
shipped to every install, so rollout ordering matters ecosystem-wide.

## Decision

### 1. Freeze the existing manifest as an immutable root segment

After a one-time cutover ceremony, `.adlc/manifest.jsonl` never changes again. Its
bytes are preserved exactly, so every existing signature remains valid with no
re-signing. The rails-guard gate is strengthened for migrated repos: the root must
be byte-identical to base, not merely prefix-extended.

### 2. Append new evidence to per-lineage segment files

New entries go to `.adlc/manifest.d/<slug>-<ulid>.jsonl`. A segment is an
independent hash chain (per-segment `seq` from 1, `prev` over raw previous-line
bytes, unchanged v2 signing). Its first entry carries a **fork anchor** — the
`{segment, seq, lineHash}` of a specific line of an existing committed segment (or
root) — binding it into history. The whole structure is a tamper-evident tree
rooted in the frozen file. Concurrent branches create *different files*, so no
merge ever rewrites a chained line and no signature is ever invalidated by a merge
or rebase.

A segment is append-open only in the checkout that created it, evidenced by a
gitignored lineage token; every other checkout treats every segment as frozen and
creates its own. ULID naming makes filename collisions across branches
practically impossible.

### 3. Relax total order to per-segment order plus anchors — with terminal revocation

The single global sequence is gone; ordering is per-segment, plus the anchor
partial order. The one consumer that needed cross-entry ordering — the cross-model
gate's "a later `needs-attention` revokes an earlier `approve`" — moves to a rule
that needs no total order: **revocation is terminal per (provider, revision)**. An
approve satisfies the gate only if no `needs-attention` for the same tuple exists
anywhere in the forest. Re-approval of a revoked revision is impossible by
construction; a fix produces a new tree hash, hence a new revision, anyway.

Rejected alternative: ordering segments by writer-claimed timestamps. Timestamps
are attacker-controlled in a PR-controlled tree, so "latest wins" across segments
would let an author fabricate a post-revocation approve. Terminal revocation is
strictly fail-closed.

### 4. Seal the root at cutover to close the version-skew hole

An old-toolkit reader on a migrated repo sees only the root. If a pre-cutover
approve stood in the root while its revocation landed post-cutover in a segment,
the old reader would fail *open*. The ceremony closes this by construction: its
final acts in the root are to append a signed `needs-attention` **seal** for every
standing root approve, then the signed cutover entry. After cutover the root
contains no standing approve, so an old reader can only fail closed (it misses
segment-recorded approvals and reports them absent). In-flight PRs must rebase and
re-record — which the tree-hash revision binding already forces after any rebase.

The migration PR also pins the minimum toolkit version in the repo's CI workflows,
so the repo's own gates always run forest-aware readers.

### 5. Ship readers before writers; scaffold greenfield repos on the new format

Rollout order is a two-phase protocol upgrade:

- **Release N:** forest-aware readers (`verify`, `show`, `attest`, the cross-model
  reader, rails-guard checks). A segments-free repo reads byte-for-byte
  identically, so this release is behavior-neutral until segments exist.
- **Release N+1:** the segment writer, the `gate-manifest migrate` ceremony, and
  an `adlc init` scaffold that creates new repos directly on the segmented layout
  (no root; first segment anchors to null). Greenfield installs never migrate.

Legacy repos migrate lazily, each via the ceremony, whenever convenient — this
repository first, as the dogfood proof, in a dedicated PR mirroring the ticket
store migration (#321).

A stale (pre-forest) writer in a migrated repo would append to the frozen root.
That cannot be prevented locally, but it is contained at the merge boundary: the
updated rails-guard gate denies root growth post-cutover, and the remedy is a
toolkit upgrade. Fail-closed, with a named cause.

### 6. No compaction at launch

Segments accumulate roughly one file per branch lineage under interactive use.
An automated CI recorder (e.g. `docs/ci/adversarial-review.yml`'s
`gate-manifest record`) accumulates faster than that: its checkout is
ephemeral and the `.lineage` token is gitignored by design (§4.8 of the
spec), so it never persists across separate job runs — a branch pushed N
times yields up to N segments from that recorder alone, not one. This isn't a
defect to route around; it's the same one-open-lineage-per-writer-context
model applied to a writer whose "context" happens to be a single CI job, and
it's exactly the volume the trigger below is calibrated to catch. No
fold-into-root ceremony ships in v1 — it would reintroduce a re-signing event
for no measured benefit. The trigger for revisiting is written down: more
than 500 segment files, or forest verification exceeding 250 ms in CI,
whichever comes first, warrants a compaction ADR.

## Consequences

### Positive

- Concurrent branches recording evidence merge without touching the same file:
  the structural manifest conflict is gone, not automated around.
- No merge or rebase ever rewrites a signed line; `ADLC_MANIFEST_KEY` is needed
  only where it is needed today (signing new entries, ceremonies).
- Existing signatures survive migration unchanged because the root is frozen,
  never rewritten.
- The skew failure mode is fail-closed by construction (sealed root), not by
  operator discipline.
- Greenfield installs land on the final format; the legacy population only
  shrinks.
- The precedent (ADR-0010) says the shape works: independent Git paths for
  logically independent work, Git remains the coordination and review system.

### Costs

- The audit story changes from "one cat-able file with a global seq" to "one
  verifiable structure": `show`/`attest` must interleave segments for display,
  and external scripts that assume a single file or global `seq` break.
- Terminal revocation is stricter than today: a provider cannot re-approve the
  same revision after revoking it, even when the concern was resolved by
  discussion rather than code.
- Forest verification is more code on the most-attacked surface in the codebase
  (anchor resolution, orphan segments, per-segment append-only); the hardening
  standard set by #314/#326/#363 must be re-met, with adversarial tamper tests as
  acceptance criteria.
- Every PR in flight at this repository's cutover must rebase and re-record.
- `.adlc/manifest.d/` accumulates files until a future compaction ADR.

### Residual risks

- The truncation honest-limit from #354 is **unchanged**: an author who controls
  the PR branch can still drop a branch-recorded revocation by truncating their
  own segment before it is committed. Closing it still requires anchoring latest
  state outside the PR-controlled tree, and remains explicitly out of scope.
- A stale writer degrades a migrated repo's root until CI catches it at merge
  time; the local experience is a red gate with an upgrade instruction, not a
  local prevention.
- Two writers in the *same* checkout on the same lineage still serialize via the
  per-segment ledger lock; two checkouts that somehow share a lineage token would
  recreate a same-file conflict for that segment only. The token protocol makes
  this an operator error, not a designed path.

## Rejected alternatives

### Union merge driver on the single file

Resolves the textual conflict while silently producing a broken chain. Today's
conflict is the alarm; removing the alarm without fixing the disease is strictly
worse.

### Auto-rechain merge driver (keep one file, rewrite and re-sign the losing suffix)

Semantically sound — the HMAC key is symmetric and repo-wide, so re-signing
preserves the same trust claim — but it needs the key exactly where it is absent
(worktrees, CI), Git merge drivers cannot be distributed via the repository, and
it automates the conflict rather than removing it. Every rebase would still churn
bytes of previously recorded evidence.

### Record evidence outside the PR merge path (post-merge bot, git notes, dedicated ref)

Attestations gate the merge itself, so they must travel with the PR; a dedicated
ref would also break offline verification and split the review surface Git
provides for free. (External anchoring remains the likely future fix for the
truncation limit — as an *addition*, not a replacement.)

### Timestamp-ordered cross-segment semantics

Preserves today's "latest per provider wins" exactly, but on writer-claimed
timestamps in an attacker-controlled tree; rejected as fail-open (see Decision 3).

### Dense global sequence preserved across segments

Allocating globally unique `seq` values across concurrent branches is the very
coordination problem being removed; any allocator (central counter file, ranges)
recreates a shared merge hotspot, as ADR-0010 found for tracked indexes.
