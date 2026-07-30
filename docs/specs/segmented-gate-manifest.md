# Spec — Segmented gate-manifest (chain forest)

Normative companion to [ADR-0015](../adr/0015-segmented-gate-manifest.md).
Implemented by ticket `T-MANIFEST-FOREST`; this repository migrates separately
under `T-MANIFEST-FOREST-MIGRATE`.

The words MUST, MUST NOT, SHOULD, and MAY are used in the RFC 2119 sense.

## 1. Objective

Eliminate the structural merge conflict in `.adlc/manifest.jsonl` by storing gate
evidence as a forest of independent hash-chained segment files bound together by
fork anchors, while preserving every existing guarantee: tamper evidence, HMAC
provenance, append-only in PRs, provider revocation, and migration-evidence
validation.

## 2. Non-goals

- Closing the truncation honest-limit (#354): an author controlling a PR branch
  can still drop their own branch-recorded entries. Unchanged, out of scope.
- Compaction of segments back into a single chain. Out of scope until the ADR's
  measured trigger fires (>500 segments or >250 ms forest verify in CI).
- Any change to entry payload schemas, signing (`sign.mjs` v1/v2), or the
  findings ledger (ADR-0014).
- Automatic migration. Migration is an explicit, dry-run-first ceremony.

## 3. Terminology

- **Root segment** — the legacy `.adlc/manifest.jsonl`. Frozen at cutover;
  absent in greenfield repos.
- **Segment** — one append-only JSONL chain file under `.adlc/manifest.d/`.
- **Fork anchor** — the binding `{segment, seq, lineHash}` in a segment's first
  entry, naming the exact committed line it forks from.
- **Forest** — the root segment (if any) plus all segments; valid when every
  chain and every anchor verifies.
- **Cutover** — the ceremony freezing the root and enabling segment writes.
- **Lineage token** — a gitignored local file marking which segment the current
  checkout may append to.
- **Standing approve** — a root `cross-model-review` entry with
  `data.verdict === "approve"` for a (provider, revision) tuple that has no
  `needs-attention` entry for the same tuple later in the root.

## 4. On-disk formats

### 4.1 Layout

```text
.adlc/
  manifest.jsonl            # root segment (legacy repos; frozen after cutover)
  manifest.d/
    <slug>-<ulid>.jsonl     # one segment per writer lineage
    .lineage                # local lineage token — gitignored, never committed
```

### 4.2 Segment filenames

`<slug>-<ulid>.jsonl` where `slug` is 1–40 chars of `[a-z0-9-]` derived from the
creating branch name (non-conforming chars dropped, lowercased, collapsed;
`segment` when derivation yields nothing), and
`ulid` is a 26-char **uppercase** Crockford-base32 ULID generated at segment
creation — matching this repo's existing ticket-id convention
(`T-01KXPD8KJ9H6M6DFA83Y82A1Z1`) and the ULID reference encoding. Grammar
validation MUST accept exactly `[A-Z0-9]{26}` for the ULID segment and reject
a lowercase or mixed-case one as a bad-filename-grammar error, not fold it —
folding would defeat the case-collision check below. The
store MUST reject (fail verification of) files under `manifest.d/` that do not
match this grammar, are not regular files, are symlinks, or are nested in
subdirectories. Two segments whose names differ only by case MUST be rejected
(case-insensitive filesystem safety).

### 4.3 Segment chain rules

Within a segment, entries follow the existing chain rules unchanged: `seq`
starts at 1 and increases strictly by 1; `prev` is `null` on the first entry and
otherwise the SHA-256 hex of the previous raw line's exact bytes; signing is the
existing v1/v2 HMAC scheme, byte-identical semantics.

### 4.4 Fork anchor

The first entry of a segment MUST carry a top-level `anchor` field; no other
entry in any segment may carry one, and root entries never do. `anchor` is a
reserved chain field (like `seq`/`prev`/`sig`): `appendManifestEntry` MUST
reject payloads that supply it.

```json
{ "anchor": { "segment": "root", "seq": 103, "lineHash": "<sha256 hex>" } }
```

- `segment` — `"root"` or the filename (without directory) of another segment.
- `seq` — the `seq` of the anchored-to entry in that segment.
- `lineHash` — SHA-256 hex of that entry's exact raw line bytes.
- Root-less form: `"anchor": null` — permitted whenever the repository has no
  root at the time the segment is created, regardless of how many other
  committed segments already exist (§5's forest is a forest of trees rooted in
  the root segment *or* in `anchor: null` segments, plural); enforced at CI
  per §9.3. Once a root exists, every new segment MUST anchor to it (§7.1) —
  `anchor: null` is unavailable from that point on.

The anchor is inside the signed byte range (v2 signs all fields), so a signed
anchor cannot be repointed without invalidating its signature.

### 4.4a Branch identity (lineage-durability, added post-slice-3)

Alongside `anchor`, a segment's first entry SHOULD also carry a top-level
`branch` field naming the EXACT Git branch that minted it — the value
`currentBranch()` returned at mint time, unmodified (never the derived
filename slug from §4.2, which is lossy: lowercased, collapsed, and truncated
to 40 chars, so distinct branches can share one). `branch` is omitted (not a
`null` sentinel) when the segment was minted from a detached HEAD, which has
no branch identity to record.

`.adlc/manifest.d/.lineage` is local and gitignored (§4.8) — it never travels
with a clone and is overwritten whenever the checkout switches to a different
branch with its own open segment. `branch` is what lets a reader recover
"which committed segment is mine" without it: `recoverOpenSegment` scans
every segment's first entry for an EXACT `branch` match, never a filename-slug
match. Because `branch` sits inside the signed byte range on any entry
carrying `sigVersion: 2` (forced whenever `anchor` is present, per above), a
caller with the signing key can trust a recovered segment's claimed identity
as much as it trusts any other signed field — a colliding derived slug is no
longer a reachable attack, only a colliding EXACT branch name, which is a
different git ref by construction. Segments minted before this field existed
simply never match `recoverOpenSegment`'s scan; they remain reachable only via
a still-valid `.lineage` token.

Exact identity is not authenticity: `recoverOpenSegment` itself (gate-manifest
and tickets alike) only matches on the `branch` field's value and does not
verify a signature — a caller must decide, from its OWN context, whether that
matters. `@adlc/tickets`' `readOwnChains(dir, {allowRecovery: true, key})`
does: when `key` is non-null, entries from a recovered (not token-matched)
segment are filtered to only those passing `entrySigValid(key, entry)`, so an
unsigned segment that merely claims the right branch cannot get its content
trusted; when `key` is null, nothing can be verified, so recovery is disabled
entirely and this falls back to root-only. Consumers that mint a FRESH
signature from recovered content (reassignment, cross-model carry-forward)
independently re-verify the specific entries they use regardless of this
filter — belt-and-suspenders, since those paths do not all go through
`readOwnChains`.

Two gaps remain, deliberately deferred to a follow-up
(T-01KYTQ4BADHSDJNBFNZHB2ZG5V) rather than folded into this same change: (1)
`resolveOpenSegment` (the WRITE side) never consults `recoverOpenSegment` — a
write that happens before any read on a fresh clone mints a fresh segment
rather than continuing a real, unambiguous, already-committed one for this
branch, and once that fresh segment's token exists, recovery's fast path
never scans further, permanently hiding the older evidence again; (2)
segments minted before this field existed have no `branch` field and gain
nothing from this mechanism — the original evidence-loss bug persists
unchanged for all pre-existing segment history until a migration/re-
attestation ceremony (or an authenticated lineage index) is designed.

### 4.5 Cutover entry (root, last entry)

Recorded by the ceremony as the final root entry, always signed:

```json
{ "seq": n, "gate": "manifest-cutover", "ts": "…", "data": {
    "reason": "<operator supplied, ≥8 chars>",
    "rootLines": n, "rootSha256": "<sha256 of all prior root bytes>",
    "sealedApprovals": k
  }, "files": {}, "prev": "<chain>", "sigVersion": 2, "sig": "<hmac>" }
```

### 4.6 Seal entries (root, immediately before cutover entry)

For every standing approve in the root, the ceremony appends one signed
`cross-model-review` entry with `data.verdict: "needs-attention"`,
`data.sealedByCutover: true`, and the same `provider`, `authorProvider`,
`revision` (and `ticket` when present) as the sealed approve. This is a
deliberate reset, not an oversight: §6's terminal-revocation rule has no
`sealedByCutover` exception, so every reader — pre-forest and forest-aware
alike — evaluates a sealed tuple as revoked. Migration is the one moment every
standing approval is known to predate the forest's trust semantics, so the
ceremony forces fresh re-approval under the new model rather than grandfathering
old ones in; §8 step 7 names this to the operator as a required follow-up.

### 4.7 Activation marker

`.adlc/manifest.d/.store.json` — a tracked marker file mirroring the ticket
store's, written by the ceremony and by the greenfield scaffold:

```json
{ "format": "adlc-manifest-segments", "version": 1 }
```

Writers treat a repo as segmented when the marker exists **or** the root's last
entry has `gate: "manifest-cutover"`; the double marker keeps a repo segmented
even if one is lost. The marker deliberately lives inside `manifest.d/` (not
`.adlc/config.json`) so pre-forest toolkits — which validate config integrity
strictly — never encounter an unknown field, and so the directory is trackable
by Git even before the first segment exists. Readers never consult the marker —
they always read whatever exists. The marker is not a segment: §4.2 grammar
checks skip exactly the names `.store.json` and `.lineage`.

### 4.8 Gitignore

The scaffold's gitignore lines gain `!.adlc/manifest.d/`,
`!.adlc/manifest.d/**`, and `.adlc/manifest.d/.lineage` — segments are trackable
in repos that track evidence, the lineage token never is. (Repos that keep the
manifest untracked simply never commit `manifest.d/`; behavior is unchanged.)

## 5. Verification algorithm

`verify(dir, { requireSignatures })` returns the existing `VerifyResult` shape,
extended with `segments: n`. It MUST:

1. Read the root (if present) and every file matching §4.2 under `manifest.d/`.
   Any non-conforming filesystem object under `manifest.d/` → invalid, reason
   named with the offending path.
2. Verify the root exactly as today (chain, seq, signature modes).
3. Verify each segment's internal chain per §4.3 with the same signature modes
   as today (`requireSignatures` semantics unchanged, applied per entry across
   the whole forest).
4. Verify each segment's anchor: the anchored-to segment exists in the forest,
   holds an entry with the anchored `seq`, and the SHA-256 of that entry's raw
   line equals `lineHash`. A dangling or mismatched anchor → invalid.
5. Reject anchor cycles: the anchor graph MUST be a forest of trees rooted in
   the root segment or in `anchor: null` segments (walk with a visited set;
   a segment reachable from itself → invalid).
6. `signed: true` under exactly today's conditions (key present, signatures
   required, every entry verified) evaluated over all entries in the forest.

A repo with a root and zero segments MUST verify with results byte-identical in
meaning to today's verifier (same valid/message/count/signed for every fixture
in the existing test suite).

## 6. Reader semantics

- `readEntries('manifest')`-equivalent forest reads return every entry from the
  root plus all segments, each annotated with its source segment. Malformed
  lines surface in `skipped` with segment + line number, never silently.
- `gate-manifest show` / `attest` display root first, then segments ordered by
  (anchored-to segment, anchored-to `seq`, ULID), entries in per-segment order,
  each labeled with its segment id. `ts` is display-only and MUST NOT be used
  for any trust decision.
- **Cross-model gate (terminal revocation).** An approve for (provider,
  revision), plus `ticket` when the caller supplies one — matched and
  per-entry signature-verified exactly as today (`candidateReview`) —
  satisfies the gate only if **no** entry anywhere in the forest carries a
  `needs-attention` verdict for the same key (providers normalized on both
  sides as today). `ticket` is optional exactly as it is today: the
  revision-wide trust-root gate (`hasCrossModelApproveForRevision`) omits it, so a
  needs-attention anywhere at that revision blocks it regardless of which
  ticket it names; the per-ticket gate (`hasCrossModelApprove`) supplies it,
  so a needs-attention scopes only to matching-ticket entries — this is why
  §4.6 seal entries carry `ticket` when the sealed approve had one, so a
  cutover seals a ticket-scoped approval without over-broadly revoking every
  other ticket's approval at the same revision. A revocation counts
  **regardless of its signature state**: revocations only ever block an
  approve, so trusting them unsigned is fail-closed, while requiring a
  signature would let a keyless author's genuine revocation be silently
  ignored. (A present-but-invalid signature on any entry still fails the whole
  forest via the existing tamper rule.) The chain-trust precondition
  (`manifestChainTrustworthy`, i.e. forest-valid with
  `requireSignatures: false`) is unchanged. Within-root historical semantics
  are subsumed: a root whose approve was followed by a root revocation has a
  revocation in the forest, so the approve does not count.

## 7. Writer semantics

When the repo is segmented (§4.7), `appendManifestEntry`:

1. Resolves the open segment: `.adlc/manifest.d/.lineage` records
   `{segment, branch}`; it is honored only when the named segment file exists,
   its recorded lineage ULID matches, **and** the current Git branch equals the
   token's branch (detached HEAD never matches). Any mismatch mints a new
   segment: generate ULID, derive slug, and anchor its first entry (per §4.4)
   to the current head line of the root if a root exists, else `anchor: null`
   — and, per §4.4a, carry the exact minting branch as that entry's `branch`
   field, so a reader can recover this segment later without a live token.
   The writer never chases the token's previously-named segment, or any other
   segment, as a fallback anchor target: two branches forked from the same
   root-less state legitimately mint independent `anchor: null` segments
   without coordinating, and whichever merges first must not retroactively
   invalidate the other's already-signed anchor — re-anchoring after the fact
   would break its signature (§4.4, anchor is inside the signed byte range).
   §5's forest is explicitly a forest of trees rooted in the root segment
   **or** in `anchor: null` segments (plural), so this is the intended shape,
   not a gap; §9.3 permits `anchor: null` on a new segment whenever the base
   tree has no root, independent of how many other segments already exist
   there, so CI accepts every branch's legitimately-null-anchored segment
   regardless of merge order. Anchor choice is bookkeeping, not a trust
   boundary: §9.3 establishes that history pinning comes from committed-byte
   append-only, not from where anchors point. The branch binding on the
   `.lineage` token is load-bearing for a different reason: without it, one
   checkout switching branches would extend the same segment on both branches
   and recreate the tail conflict this spec exists to remove.
2. Appends under the per-segment ledger lock (`withLedgerLock` on the segment
   path), deriving `seq`/`prev` from the segment's byte-exact locked state, as
   the single-file writer does today. Signing behavior is unchanged.
3. MUST refuse to append to the root (`manifest chain is frozen; this repo uses
   .adlc/manifest.d/ — upgrade adlc if you are seeing this locally`).

When the repo is not segmented, the writer behaves exactly as today (root
append). Concurrent writers in one checkout serialize on the segment lock.

## 8. Migration ceremony — `adlc gate-manifest migrate`

Dry-run by default; `--write` applies; `--json` supported. Steps, in order:

1. Refuse without `ADLC_MANIFEST_KEY` (the ceremony signs seals and cutover, and
   must verify existing signatures).
2. Run full verification (§5). Refuse on any invalidity — `repair-chain` first.
3. Refuse if unsigned entries exist, unless `--attest-unsigned` (same operator
   ceremony and disclosure as `repair-chain`).
4. Refuse if already segmented — §4.7's marker-OR-cutover-entry test, not marker
   presence alone: the double marker exists precisely so one being lost doesn't
   make the ceremony blind to a repo that already cut over, re-running and
   appending duplicate seal and cutover entries to the frozen root.
5. Compute standing approves (§3). Plan output lists each sealed tuple, the
   cutover entry, the backup path, and the config change. Dry-run stops here.
6. With `--write`, under the ledger lock: write the hash-named backup
   (`manifest.jsonl.pre-cutover-<sha16>.bak`), append seal entries (§4.6), then
   the cutover entry (§4.5), and create `.adlc/manifest.d/` containing the
   §4.7 marker. All root appends extend the existing chain normally — no prior
   byte is rewritten.
7. Print the follow-ups the operator owns: commit in a dedicated PR; pin the
   minimum toolkit version in CI workflows; in-flight PRs must rebase and
   re-record revision-bound attestations.

## 9. CI gate (rails-guard) changes

All checks remain in the single committed-tree reader
(`packages/rails-guard/lib/ci/manifest.mjs`), extended:

### 9.1 Root

- Base root not cutover: HEAD root MUST have base root as a byte prefix (today's
  rule), and the only permitted appended entries are a valid migration-evidence
  set (existing rule) or a valid seal+cutover set (§4.5–4.6, chain-verified over
  actual raw lines exactly as migration evidence is today).
- Base root cutover (last base entry is `manifest-cutover`): HEAD root MUST be
  byte-identical to base.
- Seal and cutover entries MUST structurally carry `sigVersion: 2` and a `sig`
  field; rails-guard checks presence only (it holds no key). Spoofing is
  contained, not prevented: `gate-manifest record` accepts free-form gate
  names, so a keyless author can append a structurally valid fake cutover — but
  its absent-or-invalid signature makes every keyed reader fail the forest
  closed (the existing present-but-invalid rule), so the spoof denies the
  spoofer, never widens trust.

### 9.2 Existing segments

Every segment file present at base MUST have its base bytes as a byte prefix of
its HEAD bytes (append-only per segment). Deleting or renaming a base-committed
segment file in a PR → deny.

### 9.3 New segments

Every segment file present at HEAD but not base MUST: match the filename grammar
(§4.2) as a regular blob (mode/type checked as the root is today), parse and
chain-verify internally over raw lines, and carry an anchor that resolves — with
a matching `lineHash`, cycle-checked — within the **HEAD** forest, whose
anchored-to segment is itself valid under §9.1–9.3. Resolving at HEAD rather
than base is deliberate: a PR may legitimately mint a second segment anchored to
one it added itself. History pinning comes from §9.1/§9.2 (committed bytes are
append-only), not from where anchors point. `anchor: null` is permitted
whenever the base tree contains no root — regardless of how many other
segments the base tree already has. This is deliberately **not** "no root and
no segments": two branches forked from the same root-less state each mint an
independent `anchor: null` segment (§7.1) without seeing each other, and
whichever merges second must not be denied merely because the first is now
part of base — its signed anchor can't be repointed after the fact without
invalidating the signature (§4.4), and §5's forest model is explicitly a
forest of trees rooted in the root segment **or** in `anchor: null` segments
(plural).

### 9.4 Evidence validation

`validateMigrationEvidence` retains its current behavior for the ticket-store
migration and gains the seal+cutover validation of §9.1. Trusted-base
resolution, symlink/submodule ancestor guards, and blob-hash pinned reads are
reused unchanged.

## 10. Repair

`repair-chain` operates per segment: `--segment <file>` repairs one segment's
chain (same backup, refusal, and `--attest-unsigned` semantics as today); the
bare form repairs the root and refuses when the repo is segmented and the root
is intact. Repairing a segment re-signs only that segment; anchors *into* the
repaired segment from other segments are re-verified afterward and reported if
broken (repair does not cascade automatically — a broken dependent anchor is
listed for a follow-up `--segment` run on the dependent, which MAY recompute its
anchor under the same signature-verifying ceremony rules).

## 11. Rollout and compatibility

- **Release N (readers):** §5, §6, and §9 reader-side behavior ship with no
  writer changes. A segments-free repo is behaviorally identical (AC2).
- **Release N+1 (writers):** §7, §8, greenfield scaffold (`adlc init` creates
  `manifest.d/` with the §4.7 marker and adds the §4.8 gitignore lines; no root
  file is created).
- Stale-writer containment: a pre-forest toolkit in a migrated repo appends to
  the frozen root locally; §9.1 denies it at merge with a message naming the
  toolkit upgrade as the remedy. §7.3 gives the same message locally for new
  toolkits in inconsistent states.
- Legacy repos that never migrate keep exact current behavior indefinitely;
  every reader change is additive.

## 12. Verification and acceptance criteria

- **AC1 — forest format:** Golden fixtures accept a valid root+segments forest
  and reject each of: malformed segment JSON, bad filename grammar, symlinked
  `manifest.d/` or segment file, nested directories, case-colliding filenames,
  duplicate anchors claims with mismatched `lineHash`, dangling anchor, anchor
  cycle, `anchor` on a non-first entry, and a payload supplying `anchor` to the
  writer. **Verify:** `node --test packages/gate-manifest/test/forest-format.test.mjs`.
- **AC2 — reader equivalence:** Every existing verify/show/attest/cross-model
  test passes unchanged against segment-free fixtures, and a golden test proves
  `verify` output fields are identical to the pre-forest implementation on the
  same fixtures. **Verify:** `node --test packages/gate-manifest/test/ packages/prosecute/test/`.
- **AC3 — merge benefit:** A Git integration test creates two branches from one
  base, records evidence on both, merges both to main with no conflict, and the
  merged forest verifies with all signatures intact. **Verify:**
  `node --test packages/gate-manifest/test/parallel-merge.test.mjs`.
- **AC4 — tamper:** Adversarial tests garble a committed segment line, truncate
  a segment, repoint an anchor, forge an unsigned approve, and rewrite a signed
  seal; each fails closed with a named reason at `verify` or the cross-model
  gate. **Verify:** `node --test packages/gate-manifest/test/forest-tamper.test.mjs`.
- **AC5 — terminal revocation:** An approve with a same-tuple `needs-attention`
  in any other segment (and in the root via seals) does not satisfy the gate; an
  approve for a new revision after a revoked one does. **Verify:**
  `node --test packages/prosecute/test/cross-model-forest.test.mjs`.
- **AC6 — writer:** Segmented-mode appends create/extend the lineage segment
  under lock, never touch the root, and refuse root appends with the §7.3
  message; two concurrent same-checkout writers serialize without interleaving.
  **Verify:** `node --test packages/gate-manifest/test/segment-writer.test.mjs`.
- **AC7 — ceremony:** Dry-run mutates nothing and lists seals; `--write`
  produces a root whose prior bytes are unchanged (prefix assertion), valid
  seal+cutover entries, the backup, and the §4.7 marker; each refusal
  condition in §8 has a test. **Verify:**
  `node --test packages/gate-manifest/test/migrate-ceremony.test.mjs`.
- **AC8 — CI gate:** rails-guard tests cover §9.1 (both root states), §9.2
  (segment byte rewrite → deny), and §9.3 (new segment with a dangling anchor
  → deny; null anchor on a root-less base that already has other segments,
  e.g. two concurrently-forked branches merging in either order → allow; null
  anchor on a base with a root → deny). **Verify:**
  `node --test scripts/test/rails-guard-ci.test.mjs --test-name-pattern='manifest'`.
- **AC9 — scaffold:** `adlc init` on a fresh directory produces the segmented
  layout, the §4.8 gitignore lines, and a first record lands in a segment with
  `anchor: null`. **Verify:** `node --test packages/init/test/scaffold.test.mjs`.
- **AC10 — docs:** `docs/tools/gate-manifest.md` documents the forest layout,
  ceremony, and per-segment repair; doctor reports orphaned anchors and stale
  lineage tokens read-only. **Verify:**
  `node --test packages/tickets/test/doctor.test.mjs --test-name-pattern='manifest'`
  and review of the updated doc in the PR.
- **AC11 — prosecution:** P5 passes including the trust-root-tier cross-model
  approve bound to the reviewed revision. **Verify:** `adlc prosecute --base
  main` exits 0 on the implementation branch.

Suppressions: none. A later ticket must name and justify any.
