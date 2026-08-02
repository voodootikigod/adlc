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

### 1.1 Storage modes

The ledger has two storage modes, and BOTH are first-class, permanent,
supported configurations — segmented is not a destination every repo is
expected to reach, and single-file is not a deprecation queue:

- **Single-file** (the default): all evidence in `.adlc/manifest.jsonl`.
  Simplest to read, grep, and reason about; the right mode for repositories
  with low write parallelism, which rarely hit the tail conflict this spec
  exists to remove.
- **Segmented (forest)**: evidence in per-branch segment files under
  `.adlc/manifest.d/` (§4). The right mode for repositories doing parallel
  worktree fan-out, where concurrent branches otherwise conflict on the
  single file's tail on every merge.

Mode is a per-repository choice, detected exactly as §4.7 defines (the
activation marker, or a cutover-tailed root) — no configuration file and no
environment variable. A repo enters forest mode one of two ways: greenfield
(no recorded evidence yet) via `adlc gate-manifest enable`, or with existing
history via the §8 cutover ceremony (tracked as T-MANIFEST-FOREST-MIGRATE).
The choice is one-way for now: compaction back to a single chain remains a
non-goal below.

## 2. Non-goals

- Closing the truncation honest-limit (#354): an author controlling a PR branch
  can still drop their own branch-recorded entries. Unchanged, out of scope.
- Compaction of segments back into a single chain. Out of scope until the ADR's
  measured trigger fires (>500 segments or >250 ms forest verify in CI).
- Any change to entry payload schemas, signing (`sign.mjs` v1/v2), or the
  findings ledger (ADR-0014).
- Automatic migration. Migration is an explicit, dry-run-first ceremony.

## Threat model

This section records the adversary scope this spec's mechanisms are designed
against. It is a design decision by the maintainer, stated so future work on
these mechanisms is sized against the same adversary rather than a re-derived
one. It changes no runtime behavior: every defense already merged
(signature-verified recovery, fail-closed ambiguity refusals, unsigned-entry
rejection, bounded no-follow reads) is retained as-is.

**In scope — what the ledger defends against:**

- Accidental corruption: truncated writes, malformed tails, crashed writers.
- Concurrent-writer races: two producers resolving the same append target
  (the ledger lock and the §7 single-writer invariants).
- Lost or stale local state: a missing `.lineage` token on a fresh clone, a
  token pointing at a segment that no longer exists.
- Honest-mistake divergence: a checkout switching branches mid-work, a
  rebase moving a segment's base, an operator hand-deleting a marker.
- Tamper EVIDENCE: detecting after the fact that committed evidence bytes
  changed — hash chains always, HMAC provenance when `ADLC_MANIFEST_KEY` is
  configured. Detection, not prevention.

**Out of scope — what the ledger does not claim to resist:**

- An adversary holding repository commit access but not the manifest key,
  crafting committed manifest content intended to be trusted. Commit access
  is treated as trusted for manifest purposes: whoever can rewrite the code a
  gate's evidence describes can already make the evidence moot, so the
  manifest cannot be a stronger trust root than the tree it lives in.
  Repositories that need per-author accountability on commits get it from
  Git's own commit signing, which composes with this ledger and is not
  duplicated by it.
- Denial of evidence by the branch author (#354's honest-limit, already a
  non-goal above): an author controlling a PR branch can drop their own
  branch-recorded entries.

## 3. Terminology

- **Root segment** — the single-file-mode `.adlc/manifest.jsonl` a repo
  recorded before cutting over. Frozen at cutover; absent in repos that
  enabled forest mode greenfield.
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
  manifest.jsonl            # root segment (pre-cutover history; frozen after cutover)
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

Two gaps remain open, deliberately deferred to a follow-up
(T-01KYTQ4BADHSDJNBFNZHB2ZG5V) rather than folded into this same change, and
a third is recorded as an accepted limitation rather than pending work:

1. **Write-side recovery blindness** (CLOSED, §7 point 1): `resolveOpenSegment`
   (the WRITE side) used to never consult `recoverOpenSegment` — a write that
   happened before any read on a fresh clone minted a needless fresh segment
   rather than continuing a real, unambiguous, already-committed one for this
   branch, and once that fresh segment's token existed, recovery's fast path
   never scanned further, permanently hiding the older evidence. The writer
   now tries the token, then — with a configured key only — the
   authenticated exact-`branch` recovery scan, and only then mints (see §7
   point 1 for the full resolution order, the key-gating that mirrors the
   reader, the fail-closed ambiguity contract, and why a recovered match
   never writes the token). This closure keeps the Threat model's in-scope
   promise for a lost lineage token on a fresh clone true on the write side
   for KEYED configurations; a keyless writer fails closed past a committed
   same-branch candidate by design — the keyless reader's own contract
   refuses recovered content it cannot authenticate, so extending would
   strand the checkout and minting would shadow the committed evidence;
   multi-checkout forest workflows effectively require a signing key.
2. **Pre-`branch` segments unrecoverable** (open, follow-up ticket):
   segments minted before this field existed have no `branch` field and gain
   nothing from this mechanism — the original evidence-loss bug persists
   unchanged for all pre-existing segment history until a migration/re-
   attestation ceremony (or an authenticated lineage index) is designed.
   No repository can have such segments yet (forest mode only became
   reachable with `adlc gate-manifest enable`), so this is a design
   obligation on the §8 ceremony, not live data at risk.
3. **Branch-name identity is not durable across time** (accepted
   limitation, per the Threat model section): a branch name can be deleted
   and later reused by an unrelated lineage, and a detached-HEAD checkout
   has no branch name at all, so token-less recovery can surface — or
   fail-closed refuse on — a semantically unrelated lineage's committed
   segment when the reused name's segment is still present in the tree.
   Under the recorded threat model this is accepted: every failure shape is
   a visible refusal or stale-but-authentic evidence, never silent
   corruption, and the preconditions (forest mode on, token lost, exact
   name reuse, segment still in tree) compound to rare against the
   recurring conflict cost forest mode removes. Revisiting it requires
   git-ancestry-aware identity (distinguishing "this commit already
   contains that segment's origin" from "we merely share an ancestor")
   plus a segment lifecycle (close-on-merge) — design work a future ticket
   must take whole, not a field to bolt on.

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
store's, written by the §8 ceremony, by `adlc gate-manifest enable` (the
greenfield activation command: dry-run by default; refuses on a live root, a
content-bearing `manifest.d/` without a marker, a broken two-sided gitignore
contract — the marker and segments must be committable while `.lineage` and
lock files must stay ignored — and, unless `--allow-keyless` is passed
deliberately, on a missing signing key, because keyless-minted segments can
never be authenticated by a later key, making keyless forest mode
single-checkout PERMANENTLY; re-running it on an enabled repo re-checks the
gitignore contract as a health check), and by the greenfield scaffold:

```json
{ "format": "adlc-manifest-segments", "version": 1, "auth": "keyed" }
```

`auth` (`"keyed"` or `"keyless"`) persists the forest's authentication mode:
both producers' resolvers refuse a keyless write into a `"keyed"` forest
before touching anything — a key checked only at activation would not
survive into the hook, CI job, or worktree that performs the branch's first
mint, and an unsigned first entry in a keyed forest permanently strands
every keyed clone (a v2 signature can never be added retroactively).
Markers without the field (pre-policy activations) carry no mode to
enforce.

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

1. Resolves the open segment, trying each of the following in order and
   stopping at the first that yields exactly one segment:
   a. `.adlc/manifest.d/.lineage` records `{segment, branch}`; honored only
      when the named segment file exists, its recorded lineage ULID matches,
      **and** the current Git branch equals the token's branch (detached HEAD
      never matches this fast path).
   b. Absent that, AND ONLY WITH A CONFIGURED KEY, `recoverOpenSegment`'s
      exact-`branch` scan (§4.4a), authenticated before use — a keyed write
      must not mint a needless duplicate of a segment that already,
      verifiably, belongs to this checkout (gap 1 above: a write happening
      before any read on a fresh clone, or after a lost token, used to
      always mint fresh here, permanently hiding the real segment's older
      evidence the instant the fresh one's token existed). Recovery is
      KEY-GATED, mirroring §6's reader contract exactly. A KEYLESS writer
      facing any committed same-branch candidate FAILS CLOSED: extending it
      would strand the checkout (the keyless reader refuses recovered
      content it cannot authenticate), and minting alongside it would
      shadow the committed evidence behind the fresh token for every later
      read — refusal is the only shape that hides nothing, and it is the
      same refusal the keyless reader already gives in this exact state.
      Keyless greenfield writes (no committed candidate) mint normally.
      The practical consequence, stated plainly: multi-checkout forest
      workflows effectively require a configured signing key — that was
      already true for reads, and writes now match. A KEYED writer
      authenticates the single candidate: chain intact under the key with
      no tampered or unsigned-after-signed entry, AND the branch-bearing
      FIRST entry itself carrying a verified v2 signature — a v1 signature
      does not cover `branch` or `anchor`, so a bolted-on branch claim atop
      a valid v1-signed entry still verifies, meaning "some entry verifies"
      can never authenticate the identity claim recovery selects by. The
      keyed writer REFUSES, never extends and never mints past, a candidate
      that fails: minting past an unauthenticatable same-branch segment
      would silently fork the branch's lineage, gap 1's own bug. More than
      one candidate → refuse (ambiguous), the same fail-closed contract
      `recoverOpenSegment` already gives readers: a writer must never
      silently guess which of several candidates to extend. This is a
      deliberate trade-off, surfaced by adversarial review: the same branch
      legitimately owning two committed segments (the rootless-fork note
      below) turns from a read-only limitation into a total write outage on
      any token-less checkout of that branch until an operator resolves it
      with `adlc gate-manifest adopt`, which lists the candidate lineages
      and binds this checkout to the chosen one by writing the local token.
      Because a token short-circuits recovery for every later write and
      read, adopt first applies BOTH of recovery's gates — integrity
      (refusing while any non-conforming object or unreadable first entry
      exists, so adoption cannot convert a fail-closed anomaly into
      permanent silence) and authentication (v2-verified first entry with a
      key; chain intactness alone only where the marker EXPLICITLY declares
      `auth: "keyless"`, which the keyless reader's own contract already
      matches — a forest declaring no mode requires a key, since a missing
      key is far more often an oversight than a configuration). It never touches
      committed bytes. Minting a THIRD segment instead of refusing was
      considered and rejected: that is exactly gap 1's own bug, silently
      multiplying duplicates rather than surfacing the conflict.
   c. This resolution deliberately does NOT heal (write) the `.lineage` token
      from a (b) match (adversarial-review finding): the token's downstream
      trust value — `readOwnChains`'s keyless "peeked" path (§6) treats a
      token match as proof this checkout itself minted the segment, and skips
      all signature verification on that basis alone — depends on it being
      written ONLY by a genuine mint, never from `recoverOpenSegment`'s
      unauthenticated, branch-string-only match (§4.4a: "does not verify any
      signature... only proves the claim, not that anyone with the key made
      it"). Healing from it would launder an attacker-committed, unsigned,
      branch-matching segment into the token-trusted fast path the moment any
      keyless write recovered it. The cost of not healing is purely a
      repeated (b) scan on the checkout's NEXT write — no correctness or
      security cost, since recovery is idempotent.
   Zero matches from either → mint a new segment: generate ULID, derive slug,
   and anchor its first entry (per §4.4) to the current head line of the root
   if a root exists, else `anchor: null` — and, per §4.4a, carry the exact
   minting branch as that entry's `branch` field, so a reader can recover
   this segment later without a live token. Before anything is written, the
   minted FILENAME is probed against `.gitignore` and the mint refuses if it
   is ignored: a branch-derived slug can match an ignore rule that `enable`'s
   representative probes cannot anticipate (e.g. `release-*.jsonl` on a
   `release/...` branch), and evidence recorded into an ignored file exists
   only in that checkout — never in CI or any other clone — which is silent
   evidence divergence, refused fail-closed rather than recorded blindly. Only a segment minted HERE gets
   its `.lineage` token written, so only after a genuine mint does the NEXT
   resolution on this checkout take the fast (a) path; a segment resolved
   via (b) leaves no token behind (per (c) above) and is re-scanned on the
   next write.
   The writer never chases a stale token's previously-named segment, or any
   other segment, as a fallback anchor target when actually minting fresh:
   two branches forked from the same
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
- Single-file repos that never migrate keep exact current behavior
  indefinitely — that is the permanent mode §1.1 describes, not a waiting
  room; every reader change is additive.

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
- **AC12 — write-side recovery (gap 1):** a fresh clone of a branch with a
  committed, `branch`-carrying segment S1, whose FIRST action is a real
  write through the production producer, extends S1 rather than minting a
  needless S2; the pre-clone evidence stays visible to a real consumer read
  afterwards; recovery never writes the `.lineage` token; and a genuinely
  ambiguous case (two candidate segments, no token) refuses through the
  producer without minting. **Verify:** `node --test
  packages/gate-manifest/test/segment-writer.test.mjs
  packages/tickets/test/manifest-segments.test.mjs
  --test-name-pattern='AC12'`.
- **AC13 — write-side authentication symmetry:** a keyless fresh clone's
  first write FAILS CLOSED when a committed same-branch segment exists
  (never extends, never shadow-mints; greenfield keyless mints normally); a
  keyed writer refuses an unauthenticatable single candidate — including a
  branch claim riding a v1 signature, which does not cover `branch` —
  without extending or duplicating it. **Verify:** `node
  --test packages/gate-manifest/test/segment-writer.test.mjs
  packages/tickets/test/manifest-segments.test.mjs
  --test-name-pattern='AC13'`.
- **AC14 — mint-time committability:** with an ignore rule matching the
  branch-derived slug, the first write on that branch refuses before
  recording any evidence, in both producers. **Verify:** `node --test
  packages/gate-manifest/test/segment-writer.test.mjs
  packages/tickets/test/manifest-segments.test.mjs
  --test-name-pattern='AC14'`.
- **AC15 — persisted authentication mode:** activation without a key
  refuses unless `--allow-keyless` opts in; the marker records the mode;
  a keyless write into a `"keyed"` forest refuses in both producers before
  touching anything; keyless-mode and pre-policy forests keep working.
  **Verify:** `node --test packages/gate-manifest/test/enable.test.mjs
  packages/tickets/test/manifest-segments.test.mjs
  --test-name-pattern='AC15'`.
- **AC16 — lineage adoption:** with two committed same-branch segments and
  no token, `gate-manifest adopt` lists both; adopting one makes the next
  write extend it while the other stays byte-identical; adoption refuses a
  wrong-branch, unknown, chain-broken, or non-v2-authenticated segment, a
  keyed-mode forest with no key, a detached HEAD, a non-segmented repo, a
  store holding a non-conforming object, and a store holding an unreadable
  first entry, writing nothing in each case; a keyless-mode forest adopts on
  chain-intactness alone. **Verify:** `node --test
  packages/gate-manifest/test/adopt.test.mjs`.

Suppressions: none. A later ticket must name and justify any.
