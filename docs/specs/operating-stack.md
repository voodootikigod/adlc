# Spec — The ADLC Operating Stack (quartermaster layer)

**Phase:** P1 working spec. Deliverable of this ticket is the **design** (this spec);
the build items in §9 are follow-on tickets, each independently executable. Companion
strategy doc (personal economics, kept out of repo): `~/ideal-agentic-setup.md`.

Status: **proposed, revision 12** — revised after eleven cross-model adversarial
review rounds (codex). Round 1: registry-as-attack-surface, tier-only routing gap,
gateway identity assertion, missing quorum, non-computable monitors, undefined
fallback. Round 2: symbolic selection still downgradeable, fallback transport
collision, gateway quorum collapse, unvalidated job labels, usage-schema
incompatibility, undefined telemetry producers. Round 3: float lives on the
assignment not the ticket, spend needs transport dimensions, attestation schema
must version across ALL producers/readers (incl. carry-forward), author identity
was caller-asserted, cap-hit readiness indistinguishable from zero events.
Round 4: authorship split into dispatch provenance + post-build revision binding,
quorum seats bound to one review-set snapshot, readiness made interval-scoped and
historical. Round 5: fleet origin anchored in an out-of-tree run ledger (record
deletion cannot downgrade to asserted authorship), quorum seats bound to exact
snapshot members (adapter+model), readiness became a two-direction state
transition (disabled gaps representable). Round 6: adapters must force and
attest the concrete executed model (no `default` aliases for reviewer seats),
authorship became set-valued with lineage (composites and amendments stay
fleet-origin absent an explicit human-takeover record), review sets gained
terminal semantics with an out-of-tree head anchor (a deleted negative suffix
fails closed). Round 7 (post-rebase, full change-set incl. build tickets):
phase-2 binding gained an ancestry-bearing anchor (repoIdentity + headCommit +
resultCommit; descent on the commit graph; squash merges record a lineage head;
unavailable objects fail closed). A Gemini fresh-family round between rounds 6
and 7 returned zero material findings. Finding trajectory: 6 → 6 → 5 → 3 → 3 →
3 → 4 (round 7 includes ticket-authoring findings, addressed in T152/T151).
Round 8: rewrites bridged via stable patch-ids (rebase/cherry-pick stay
fleet-origin), author-family exclusion derives from the phase-2 resolvedAuthor
(build aliases cannot misbind identity), T152 rewritten around the real P4
producer (fleet dispatch) with a binding no-fabrication rule (unknown ≠ zero,
usageStatus sibling). Round 9: an unsigned authorization entry was caught and
re-recorded signed (chain verifies at 115 entries); modified rewrites gained the
fail-closed overlap classifier; composite authorship became a per-contributor
resolvedAuthor mapping; P5 packet usage is "claimed" never "reported"; P4 usage
requires adapter parsers of real machine-readable harness output; the
pass-completed entry is the sole usage carrier (exactly-once, exact totals).
Round 10: modelProviders table gives alias resolutions a trusted provider
mapping (no phase-1 fallback); overlap classifier became rename/copy-aware
(source + destination paths); the ledger-head review set must itself be
complete and satisfied (no backward search past a partial head); P5 usage
carriers deduplicate by callId across packet retries. Round 11 (consistency
propagation — no new attack classes): modelProviders threaded into the registry
example, validation rule 7, AC2, and T151; resolvedModel attestation made
mandatory for every adapter on alias-based build channels incl. claude-code;
copy detection specified as exhaustive (--find-copies-harder semantics,
fail-closed on skipped/exhausted detection) with the retained-source copy AC.
Proposed plugin/package name: `adlc-quartermaster` (alternatives in §11).

---

## 1. Goal

Define the ADLC's **operating stack**: the layer that decides *which judgment source
serves which lifecycle phase, through which channel, at what cost class, with what
fallback* — and makes those decisions deterministic, recorded, and periodically
re-evaluated against measured data instead of vibes.

Today this knowledge lives in heads and chat transcripts. The router assigns abstract
tiers (`cheap`/`mid`/`frontier`), but nothing binds a tier to a concrete **channel**
(provider/model + transport + rate window + cost class). This spec makes that binding
a declarative, versioned, **operator-local** artifact — nothing in a candidate tree
participates in channel selection — and closes the loop with spend telemetry.

This is **process engineering**: the layer above both the harness columns
(`plugins/adlc-*`) and the multiplexer layer (`plugins/adlc-herdr`). Most teams
optimize inside a harness; this layer optimizes the *portfolio* of harnesses,
providers, and subscriptions as a single system.

## 2. Why this is a new layer, not a 9th harness column

Following the argument in `docs/herdr-integration-plan.md` §1:

- Harness plugins live *inside* one harness. herdr lives *above* harnesses
  (observation). The quartermaster lives above **both**: it decides which harness
  is even in the driver's seat for a given call, and on whose subscription.
- It is cross-harness by construction: it emits configuration the fleet's
  WorkerAdapter layer (`packages/fleet/lib/adapters/`) and the cross-model gate
  consume; it never touches harness internals.
- Like the herdr plugin, it is **not an enforcement tier** for code changes — rails,
  gates, and P5 prosecution stay where they are. It *is* authoritative for one thing
  only: channel selection and its recording.

## 3. The stack (layers, fixed roles)

| Layer | Component | Role | Never does |
| --- | --- | --- | --- |
| Cockpit | herdr + `plugins/adlc-herdr` | Human-supervised parallel sessions; observe `.adlc/` state | Decide control flow |
| Orchestrator | `@adlc/fleet` | Deterministic ticket execution: worktrees, sandbox, gates, merges | Let a model decide ordering/retries/merges (D0) |
| Quartermaster | **this spec** | Bind lifecycle jobs → channels; record transport; watch triggers | Author or review code; read any config from the candidate tree |
| Model plane | harness adapters (claude-code, opencode, codex, …) | Judgment | Hold control flow |
| Rails | deterministic gates | Free enforcement | Consume tokens |

## 4. The channel registry — operator-local, entirely

**Design rule (review round 2, finding 1): the candidate tree participates in
channel selection not at all.** Revision 2's committed "symbolic half" is deleted —
any repo-side selection, however symbolic, is a downgrade surface (repoint
`frontier` at a cheap target, swap trust-root members for weak-but-distinct
families). The registry is now a single operator-local file.

### 4a. Channel names are a closed set, fixed by this spec

`frontier`, `frontier-metered`, `mid`, `cheap`, plus the reviewer groups in §6.
Code references channels only by these names. Adding a channel is a spec revision,
not a config edit — so a registry cannot invent routes the routing contract (§5)
never sanctioned.

### 4b. `quartermaster.json` — operator-local registry

Lives outside every candidate tree, resolved the way `adversarial-review` resolves
its config: absolute path in the operator's home/XDG dir; a configured path that is
relative or inside the repo under review **disables** the registry (loud notice)
rather than loading it. Fleet workers never read it; only the dispatching fleet
process does.

```json
{
  "version": 3,
  "channels": {
    "frontier":         { "adapter": "claude-code", "model": "default",          "transport": "subscription:anthropic-max",  "provider": "anthropic" },
    "frontier-metered": { "adapter": "claude-code", "model": "default",          "transport": "api:anthropic-batch",         "provider": "anthropic" },
    "mid":              { "adapter": "opencode",    "model": "zai/glm-5.2",      "transport": "gateway:opencode-go",         "provider": "zai",      "rateWindow": "5h" },
    "cheap":            { "adapter": "opencode",    "model": "deepseek/v4-flash","transport": "gateway:opencode-go",         "provider": "deepseek", "rateWindow": "5h" }
  },
  "reviewerGroups": {
    "cross-model-routine":    { "quorum": 1, "members": [
      { "adapter": "opencode", "model": "qwen/qwen3.7-coder", "transport": "gateway:opencode-go", "provider": "alibaba" } ] },
    "cross-model-trust-root": { "quorum": 2, "members": [
      { "adapter": "opencode", "model": "moonshot/kimi-k3",   "transport": "gateway:opencode-go", "provider": "moonshot" },
      { "adapter": "codex",    "model": "gpt-5.3-codex",      "transport": "subscription:chatgpt-plus", "provider": "openai", "directAuth": true } ] }
  },
  "modelProviders": {
    "claude-code": { "claude-opus-5": "anthropic", "claude-sonnet-5": "anthropic", "claude-haiku-4-5": "anthropic" },
    "codex":       { "gpt-5.3-codex": "openai" },
    "opencode":    { "zai/glm-5.2": "zai", "deepseek/v4-flash": "deepseek", "qwen/qwen3.7-coder": "alibaba", "moonshot/kimi-k3": "moonshot" }
  }
}
```

Validation rules (load-time, before any dispatch):

1. **Closed names:** every §4a channel name present, no others; unknown keys are
   errors, not extensions.
2. **Adapter allowlist:** `adapter` must name a module in
   `packages/fleet/lib/adapters/`; no `command`/argv-shaped fields exist in the
   schema at all — execution shape stays inside the adapter modules.
3. **Fallback transports must differ** (review round 2, finding 2): `frontier` and
   `frontier-metered` sharing a `transport` value is a validation error — the only
   fallback edge exists to change transport, so identical transports make it
   unsatisfiable by construction.
4. **Transport taxonomy is closed:** `subscription:*` (harness-native auth, direct
   to provider), `api:*` (direct metered API), `gateway:*` (mediated). The prefix
   is load-bearing for §6's quorum rules.
5. **Fail closed:** missing registry, disabled path, schema violation, or a channel
   the routing contract requests that has no entry → gate failure before dispatch.
   No defaults.
6. **No mutable aliases for reviewer-group members (round 6 finding 1):** a
   member `model` of `default` (or any alias the adapter resolves at run time) is
   a validation error — reviewer identity must be a concrete model ID. Build
   channels may use `default` (their identity is less load-bearing), but their
   usage records still carry the attested resolved model (§4c).
7. **Concrete-model provider mapping (round 10 finding 1):** the registry
   carries a `modelProviders` table — `(adapter, concreteModel) → normalized
   provider` — covering **every model an allowed build alias can resolve to**.
   Phase-2 `resolvedAuthor` mapping (§6) resolves through this table only:
   an attested concrete model absent from the table **fails closed** (the
   binding cannot be completed), and implementations must never fall back to
   the phase-1 declared provider or to model-string heuristics. Channels whose
   alias resolutions are not enumerable must use concrete model IDs instead of
   aliases.

### 4c. WorkerAdapter contract: force and attest the concrete model

A registry label proves nothing about what ran. The adapter contract is extended
with two obligations, both required for reviewer seats:

- **Force:** the dispatcher passes the registry `model` explicitly into the
  adapter invocation (e.g. `opencode run -m <model>`, the codex model flag) —
  never relying on the harness's ambient default. An adapter that cannot accept
  an explicit model cannot serve a reviewer seat.
- **Attest:** the adapter's result reports `resolvedModel` — the concrete model
  the harness says actually executed (from its own output/metadata). The recorder
  compares `resolvedModel` to the seat's snapshot member and **rejects the seat
  on mismatch** (fail closed, not silent substitution).
- **Attestation is mandatory for every adapter allowed on an alias-based build
  channel (round 11 finding 2)** — not just reviewer seats. The reference
  `frontier`/`frontier-metered` channels use `claude-code` with `default`, so
  the claude-code adapter must surface `resolvedModel` (its harness's
  machine-readable output reports the model) or those channels must switch to
  concrete model IDs. An adapter that cannot attest may not be bound to any
  alias-based channel — validation rejects the combination.

This changes build item 3: `fleet/adapters/opencode.mjs`, `codex.mjs`, **and
`claude-code.mjs`** must pass the model argument (where applicable) and surface
`resolvedModel`.

The repo carries only `docs/integrations/quartermaster-registry.md` — schema
reference and an annotated example. Dispatch never reads it.

## 5. Lifecycle-job routing contract (validated, not caller-trusted)

**Design rules (round 1 finding 2; round 2 finding 4; round 3 finding 1).**
`assign.mjs` keeps emitting `{tier, mode, budget, float}` unchanged (its output
already carries the CPM float — see `assignTicket`'s return shape). Channel
selection is a distinct total function — and it does not trust the caller's job
label:

```
routeJob({ job, assignment, ticket }) -> { channel } | { reviewerGroup } | { deterministic: true }
```

- `job` is a closed enum (unknown → throw).
- **Float comes from the assignment, not the ticket.** Stored tickets have no
  `float` field — CPM float is computed by `@adlc/core`'s `computeFloat(tickets)`
  and placed on the router assignment. For `build.*` jobs, `routeJob` derives the
  build class from `ticket.category` and `assignment.float`:
  `category ∈ {contract, spec, architecture}` → spec-class; else
  `assignment.float === 0` → critical-path; else ladder-start.
  `assignment.float` **must be a finite number** — absent or non-numeric float
  throws (it must never default to ladder-start, which would silently downgrade
  critical-path work). A caller-supplied `build.*` label that disagrees with the
  derivation **throws** (mislabeled dispatch is a bug, not a route).
- Non-build jobs are structural (the call site *is* the lifecycle stage — the
  prosecution driver calls with `prosecute.*`, the gate runner with `gate.*`), so
  label validation is derivation for `build.*` and enum-membership elsewhere.

| `job` | Routing | Notes |
| --- | --- | --- |
| `build.spec-class` (derived) | `frontier` | category ∈ {contract, spec, architecture} |
| `build.critical-path` (derived) | `frontier` | `float === 0`; overrides assignment tier for channel purposes; assignment tier still governs budget |
| `build.ladder-start` (derived) | assignment tier's channel (`cheap`/`mid`) | Escalation per F8 is a fresh attempt — §5a |
| `prosecute.lens` | `mid` | First-pass fan-out |
| `prosecute.verdict` | `frontier` | The **only** overflow-eligible job (§7) |
| `review.cross-model.routine` | group `cross-model-routine` | |
| `review.cross-model.trust-root` | group `cross-model-trust-root` | Quorum ≥2 (§6) |
| `maintain.ratchet` / `maintain.mining` | `mid` | Scheduled, latency-irrelevant |
| `maintain.calibration` | `frontier-metered` | Batch pricing |
| `gate.deterministic.*` | `{deterministic: true}` | Asserting a channel here is an error |

### 5a. Ladder escalation: the seat belongs to the ATTEMPT

`build.ladder-start` names a **starting** rung, not the model a ticket runs on.
F8 makes a failed strike a *fresh attempt*, and the ladder's economics depend on
it: slack work starts cheap precisely because a failure escalates. Without
escalation a cheap first attempt is only a cheaper way to fail — and
`assign.mjs`'s ladder budget (starting tier **plus one frontier regeneration**)
is provisioned for an attempt that would never happen.

Implemented in `@adlc/quartermaster`'s `lib/escalate.mjs`, consumed by fleet's
`planSeats` (which resolves every rung against the registry at planning time) and
by `live-deps` dispatch (which selects the rung for the strike in hand).

- **The ladder is `cheap → mid → frontier`**, derived from `LADDER_TIER_CHANNELS`
  so it can only climb to channels routing already starts on. `frontier-metered`
  is **not** on it — that channel is reached by a §7 fallback traversal (a
  transport change), never by climbing.
- **Attempt 1 is the routed channel**; each later attempt climbs exactly one rung
  and **stops at `frontier`** rather than indexing past the top.
- **Both `job` and `mode` gate escalation.** A ticket below the rail-density floor
  is assigned `{tier: 'frontier', mode: 'direct'}` while still *deriving*
  `build.ladder-start` from its non-zero float. Keying on the job alone would
  escalate a ticket the router deliberately routed direct, so escalation requires
  `job === 'build.ladder-start'` **and** `mode === 'ladder'`.
- **Every rung is provisioned** before the pipeline starts. Escalation can move a
  later strike onto a different harness, and an adapter's `provision` writes state
  its worker needs to run at all; provisioning only the starting rung would leave
  an escalated strike unprovisioned, which is indistinguishable from a model
  failure at the point it bites.
- **The §8a dispatch carrier names the channel that RAN**, plus `escalatedFrom`
  when it climbed. A carrier naming the starting channel for an escalated strike
  is the same "the label proves nothing about what ran" failure §4c closed for
  `model`, and it would price the escalation at the starting seat's transport.

## 6. Cross-model attestations: quorum with gateway discounting

**Design rules (round 1 findings 3–4; round 2 finding 3).**

**Quorum.** Trust-root review is a reviewer group: `quorum` members must return
independent verdicts; provider families must be pairwise distinct after
`cross-model.mjs#normalizeProvider`; none may equal the author's family. Fewer
reachable members than `quorum` **fails closed** with a loud under-satisfaction
notice. Verdicts combine per `docs/specs/multimodel-review.md`: any material
finding → `needs-attention`; `approve` requires all quorum members to approve.

**Gateway discounting (the round-2 fix).** An unauthenticated gateway can alias or
misroute model IDs, so declared families behind one gateway cannot prove diversity.
Rule: **all members sharing a `gateway:*` transport count as one family for quorum
purposes**, regardless of declared provider. Consequently a quorum-2 group must
include at least one member on a `subscription:*` or `api:*` transport — a channel
whose auth handshake is with the provider itself (`directAuth: true` marks this;
validation requires it on non-gateway members). The reference registry satisfies
this: Kimi-K3-via-gateway (one seat) + codex-direct-to-OpenAI (one seat).

**Bound identity — schema v2, versioned across every producer and reader (round 3
finding 3).** Attestation entries gain `attestationSchema: 2` with fields
`provider`, `transport`, `model`, `seatRole` (`"member"` | `"escalation"`),
`registryDigest` (SHA-256 of the registry file used at resolution), and — per the
quorum-snapshot rule below — `reviewSetId` and `groupSnapshot`. The migration is
atomic across the whole surface, not just `recordCrossModelReview`:

**Seats bind to one coherent quorum snapshot (round 4 finding 2).** Individually
valid seats must not be combinable across retries or registry revisions:

- The review driver mints one `reviewSetId` (unique per review invocation) and
  every seat entry of that invocation carries it, plus a `groupSnapshot`
  `{group, quorum, members: [{adapter, model, provider, transport}, …]}` frozen
  at invocation — **full member identity, not provider+transport alone (round 5
  finding 2)**, so a cheaper same-provider/same-transport model registered
  elsewhere in the registry cannot occupy a stronger member's seat.
- The recorder validates a seat's `(adapter, model, transport)` against **the
  named group's snapshot member**, not against "anywhere in the registry."
- The verifier evaluates **one review set atomically**: quorum is satisfied iff a
  single `reviewSetId` contains ≥ `quorum` approving seats whose `registryDigest`
  values are identical and where each seat matches **one distinct member** of the
  snapshot. Seats from different `reviewSetId`s or mixed digests never combine; a
  retry mints a fresh set and starts from zero.
- **Terminal-set semantics — the ledger-head set is the only set (rounds 6 and
  10).** Selection is not existential and never searches backward: for a given
  revision, **only the ledger-head review set counts, and it must itself be
  complete and satisfied**. A head set that is incomplete (a member unreachable
  after another seat recorded), under-satisfied, or carrying any material
  verdict **blocks approval outright** — the verifier must not fall back to an
  older complete approving set (round 10 finding 3: a partial newer set would
  otherwise launder an earlier approve past a newer `needs-attention` seat).
  The review driver records each `(revision, reviewSetId)` head in the **same
  out-of-tree ledger** as fleet provenance; at verification, a manifest whose
  latest set for the revision is older than the ledger head — or missing —
  **fails closed** (a deleted negative suffix is a chain-integrity failure,
  not a reversion to the earlier approve).
- Carry-forward names **exactly one previously satisfied `reviewSetId`** — which
  must be the ledger-head set for its revision — and carries that set's complete
  seats; it cannot assemble a set from fragments.

- **Producers:** `recordCrossModelReview` **and** `carryForwardCrossModelReview`
  emit v2. Carry-forward copies the identity fields of the carried entry verbatim
  (it re-binds nothing — it attests "same diff, same reviewers") and **carries the
  complete quorum seat set**, one entry per original member, never a single
  collapsed verdict.
- **Readers:** `hasCrossModelApprove` / `hasCrossModelApproveForRevision` (and the
  quorum verifier this spec adds) branch on schema version. For **trust-root**
  quorum, v1/legacy entries — which lack transport — **cannot occupy a seat**
  (fail closed: unbound entries can't be transport-discounted, so they can't prove
  diversity). For **routine** review, v1 entries remain acceptable until the flag
  day recorded in the migration ticket, so existing carried approvals don't block
  unchanged diffs.
- The recorder rejects a v2 record whose `(model, transport)` is absent from the
  registry or whose provider disagrees with the registry's binding; `provider`
  comes from the registry, never from a CLI flag or any committed file.

**Author identity is bound in two phases (round 3 finding 4; round 4 finding 1).**
The distinctness and quorum rules compare reviewer families against the
**author's** family — which today arrives as a caller-asserted `--author-provider`
flag. A single dispatch-time record cannot carry the reviewed revision, because
the revision does not exist until the worker has edited the tree. So the binding
is two records, both signed:

- **Phase 1 — dispatch provenance** (written at dispatch, before the build): keyed
  by immutable run identity `{runId, ticket, attempt}`, carrying the resolved
  channel identity `{channel, provider, model, transport, registryDigest}`. No
  revision field — none exists yet.
- **Phase 2 — revision binding** (written by the fleet's post-build gate path,
  the same trusted process that computes the change-set digest): binds the actual
  reviewed revision to its contributing dispatch record(s) **and to an
  ancestry-bearing anchor** — a change-set identity (`git-change:<base>:<digest>`)
  carries no parent links and may describe uncommitted state, so it cannot answer
  descent questions by itself (review round 7 finding). The binding records:
  `{revision, repoIdentity, headCommit, resultCommit, patchIds,
  contributors: [{dispatchRecord: {runId, ticket, attempt},
  resolvedAuthor: {model, provider}}, …]}` where `resultCommit` is the
  immutable commit OID of the fleet's committed result, `headCommit` is the
  HEAD the change-set digest was computed against, and `patchIds` are the
  stable patch identities of the result commits (the rewrite bridge, below).
  **Per-contributor `resolvedAuthor` closes the build-alias hole for composites
  (round 8 finding 2; round 9 finding 3):** build channels may use a runtime
  alias (`default`), so a phase-1 declaration can differ in family from what
  actually executed — and a composite revision can have contributors whose
  aliases resolved to *different* families. The binding therefore carries a
  signed **one-to-one mapping** from every contributing dispatch to its
  adapter-attested `resolvedModel`, registry-mapped to a resolved provider.
  Validation requires exact coverage (every dispatch appears exactly once) and
  **author-family exclusion excludes the resolved family of every
  contributor** — never a single collapsed author, never the phase-1
  declaration. A binding missing a contributor's resolution, or one whose
  resolved provider cannot be mapped, fails closed.
- **Descent is decided on the commit graph, fail-closed on ambiguity.** A
  candidate revision's lineage check walks git ancestry from the candidate's
  HEAD: if any ancestor is a recorded `resultCommit` (or lineage head, below),
  the revision is fleet-origin. Defined cases:
  - *Dirty working tree:* inherits its HEAD's classification (the digest may
    describe uncommitted edits; ancestry runs on the underlying HEAD).
  - *Merges:* preserve ancestry naturally — no special handling.
  - *Rebases and cherry-picks* (round 8 finding 1): history **rewrites** produce
    commits that do NOT descend from the recorded `resultCommit` even though the
    old object still resolves — so "not an ancestor" must never be read as
    "not fleet-origin" for rewritten content. The ledger therefore also records
    the **stable patch identity** (`git patch-id --stable`) of every
    fleet-authored commit, and the lineage check is: commit-graph ancestry **or**
    patch-id intersection between the candidate's commits and recorded fleet
    patch-ids. A rewrite performed by trusted tooling (the fleet's own rebase
    path) additionally re-binds the new commits as fresh lineage heads.
  - ***Modified* rewrites — the overlap classifier (round 9 finding 2):** a
    cherry-pick with a one-byte edit, a conflict-resolved rebase, or an amend
    destroys both ancestry and the patch-id. Content attribution of arbitrarily
    modified diffs is unsolvable in general, so the classifier is deliberately
    over-broad in the fail-closed direction: a candidate matching neither
    ancestry nor patch-id whose **changed paths intersect the recorded
    change-set paths of any fleet binding** that has not been released by a
    signed human-takeover (or superseded by a trusted re-bind) is **ambiguous →
    fail closed** — fleet-origin presumed, asserted authorship unavailable
    until a takeover record exists. **Path sets are rename/copy-aware (round 10
    finding 2; round 11 finding 3):** changed paths are computed with git's
    **exhaustive** copy detection — `--find-copies-harder` (which considers
    unmodified files as copy sources; plain `-C` does not) or an equivalent
    deterministic source-attribution algorithm — and include **both source and
    destination** of every rename or copy, so copying a fleet-authored file to
    a new path (source untouched) and editing the copy still intersects the
    recorded source path. If copy detection is skipped, truncated by its
    candidate limit, or otherwise exhausted, the classifier **fails closed**
    rather than proceeding with a partial path set. Trusted re-binds preserve
    the union of historical paths, not just the current ones. False positives (a human
    editing a file the fleet also touched) are resolved by the same takeover
    ceremony, which is cheap and audited; false negatives would be silent
    authorship laundering, which is not.
  - *Squash merges:* destroy ancestry, so the fleet's PR-merge path records the
    post-squash mainline commit as an **additional lineage head** in the ledger
    at merge time; descent from it is then ordinary ancestry.
  - *Unavailable objects* (shallow clone, gc'd commits, unknown repo identity):
    the ancestry question is unanswerable → **fail closed** (treat as
    fleet-origin; prosecution requires the trusted context where objects
    resolve). Ambiguity never falls through to the asserted-author path.
- **Fleet origin is established out-of-tree, never inferred from record presence
  (round 5 finding 1).** Branch-carried manifest records can be deleted by a
  branch author (the manifest reader tolerates dropped branch-only entries by
  design), so "no provenance records" must never be read as "human-authored."
  The fleet writes to an **out-of-tree run ledger** (operator/CI-side, same
  custody class as the registry; surfaced to CI through the trusted-context
  pattern already used by `cross-model-gate.yml`).
- **Authorship is a set with lineage, not a single exact-keyed row (round 6
  finding 2).** The ledger records two things:
  1. `revision → contributing dispatch records` — **set-valued**: a composite
     revision lists every contributing `{runId, ticket, attempt}`, and the
     independence rule excludes **every** contributing family from reviewer
     seats, not just one resolved author.
  2. A **lineage high-water mark** per fleet run/branch (the run's head
     revisions). A revision *descending from* a fleet lineage head — a one-byte
     amendment, a merge of fleet output — is still **fleet-origin**: the exact
     key missing from the ledger does not permit the asserted path. Fleet-origin
     without a matching binding → fail closed. The only way a fleet-descended
     revision re-enters the asserted path is an explicit, signed **human-takeover
     record** written by the operator (a deliberate ceremony, not an inference).
  - Ledger has no entry **and** the revision descends from no fleet lineage → the
    asserted path is permitted.
- The quorum verifier resolves the author family set via **ledger → binding →
  provenance**. A conflicting CLI/env assertion is recorded as non-gating
  metadata and cannot change the gating comparison.
- When the ledger has no entry and no lineage matches (human-authored outside the
  fleet), the asserted value is used but the attestation records
  `authorIdentity: "asserted"` so audits can distinguish bound from asserted
  provenance.
- **Honest limit, stated plainly:** none of this proves which model a gateway
  actually served (ADR-0007's conceded class). What the design guarantees is
  (a) forging a provider label — reviewer *or* author — requires compromising the
  operator-local registry or the CI key, not a PR branch or a CLI flag; and
  (b) gateway uncertainty can never satisfy more than one quorum seat.

## 7. Fallback: a state machine, not a graph

**Design rule (round 1 finding 6).** Exactly one fallback edge exists:
`frontier → frontier-metered`, traversable only by `prosecute.verdict`, and — per
§4b rule 3 — guaranteed by validation to change transport.

- **Eligible failure classes** (pre-execution only): adapter binary absent, auth
  failure, or a rate-limit/cap response received **before any output**. Mid-run
  timeouts, partial output, nonzero exits after output, and gate failures are
  **not** fallback-eligible — they flow to the fleet's existing two-strike policy.
- **Attempt isolation:** a fallback attempt is a fresh attempt (F8 semantics) —
  no reuse of the failed attempt's partial state. (`prosecute.verdict` is
  read-only over the candidate diff, so this is trivially satisfied; stated for
  future edges.)
- **Telemetry attribution:** each attempt records its own usage entry labeled with
  its channel; a traversal records both attempts.
- **One hop, then stop:** an unreachable fallback is a gate failure.
- All other jobs: channel unreachable → immediate gate failure.

## 8. Telemetry and trigger monitors

**Design rules (round 1 finding 5; round 2 findings 5–6): adopt the existing
schema, and name every producer.**

### 8a. Usage records: the existing gate-manifest schema, unchanged

`packages/gate-manifest/lib/spend.mjs` already defines the spend contract:
`usage: { inputTokens, outputTokens, cachedTokens, provider, model, tier }`,
aggregated by `aggregateSpend()`. This spec **adopts those field names verbatim**
— no parallel token schema exists (rev 2's `tokensIn/tokensOut` envelope is
deleted; it would have aggregated to zero).

**Routing dimensions ride the entry, not the usage object (round 3 finding 2).**
`aggregateSpend()` collapses to phase/gate totals and discards provider/model/
transport — so an entry recorded by a quartermaster dispatch carries three
**mandatory sibling fields** alongside the untouched `usage` object: `channel`,
`transport`, and `registryDigest`. Spend consumers **filter entries first,
aggregate second**: the overflow monitor selects entries whose `transport` has the
`api:` prefix (within the time window), then pipes only those through
`aggregateSpend()`, pricing per `usage.model`. This is what distinguishes
`subscription:anthropic-max` spend from `api:anthropic-batch` spend when a
fallback traversal produces both with identical provider/model/tier.

### 8b. Event records: every consumer has a named producer

Non-usage telemetry lives in `.adlc/telemetry/events.jsonl` (append-only; each
record `{v: 1, ts, kind, ...}`; unknown `kind`s are skipped and counted). All
times UTC; windows are rolling and inclusive of the current day.

**Producer readiness is explicit, interval-scoped, and historical (round 3
finding 5; round 4 finding 3).** A monitor must never read "zero matching records"
as "nothing happened" when the producer was not enabled — including for *part of*
its evaluation window. The operator registry carries a per-channel capability
block — `"capabilities": { "capHitClassification": true }` — set only after the
harness's exit-code classification has been probed (§11 Q3). Two consequences:

- **Readiness is a state transition, so gaps are representable (round 5
  finding 3):** on **every** registry load, the dispatch wrapper appends a
  `producer-readiness` event carrying the capability's current state —
  `{channel, capability, enabled: true|false, transport, registryDigest}` —
  including `enabled: false` loads. Coverage intervals are derived from the
  ordered transitions: an `enabled: true` event opens an interval, the next
  `enabled: false` (or transport change) closes it. Restoring the original
  registry bytes later re-opens a **new** interval; it never backfills the gap —
  a disable/re-enable pair on the same transport and digest leaves the
  intervening days uncovered.
- **Capability-gated monitors evaluate only covered intervals for the current
  transport.** `cap-hit` events carry `transport` and `registryDigest`; events
  from a since-replaced transport are excluded. If any part of the trailing
  window is uncovered for the active channel's current transport, the monitor
  reports **unknown**, naming the uncovered span — 29 unobserved days plus one
  quiet day is unknown, not quiet.

| `kind` | Producer (who writes it) | Fields |
| --- | --- | --- |
| `cap-hit` | dispatch wrapper, from exit-code classification — emitted only when the channel's `capHitClassification` capability is true | `channel`, `transport`, `registryDigest` |
| `producer-readiness` | dispatch wrapper, on **every** registry load (state transition, both directions) | `channel`, `capability`, `enabled`, `transport`, `registryDigest` |
| `rate-limit` | dispatch wrapper, from adapter 429/limit classification | `channel`, `model` |
| `merge` | fleet, on each successful integration-branch merge (same code path that marks `completed:true`) | `runId`, `ticket` |
| `fallback` | dispatch wrapper, on a §7 traversal | `from`, `to`, `job` |
| `gate-failure.channel` | fleet, when a dispatch fails closed on channel resolution | `channel`, `job` |

Escalation is not a separate event: attestation entries (§6) carry a `seatRole`
field — `"member"` or `"escalation"` — written by the recorder; the idle-reviewer
monitor counts `seatRole: "escalation"` entries in the manifest itself.

### 8c. Monitors

Report-only (exit 0 quiet / exit 2 findings, house convention). GitHub issues use
dedup key `quartermaster:<trigger>:<ISO-week>`; an existing open issue for a key is
updated, not duplicated. Monitors never mutate the registry.

| Trigger | Rule (deterministic) | Issue |
| --- | --- | --- |
| Frontier cap-hits | **unknown** unless readiness intervals for the active `frontier` transport cover the full trailing 30 days; else `cap-hit` (current transport only) on >2 distinct UTC days in that window | "Re-upgrade subscription" |
| Rate-window collision | ≥1 `rate-limit` on a UTC day that also has ≥1 `merge` | "Add direct API for model X" |
| Metered overflow | `aggregateSpend` over `api:*`-transport entries, priced via versioned `pricing.json` (`{version, model, inPerMTok, outPerMTok, currency:"USD"}`), > `overflowUsdThreshold` (default 30, operator-local) in trailing 30 days; pricing version quoted in the finding | "Revisit tiering" |
| Idle frontier reviewer | 0 `seatRole:"escalation"` attestations in trailing 60 days **and** ≥5 trust-root reviews in the window (opportunity denominator) | "Cancel frontier reviewer line" |
| Channel unreachable | any `gate-failure.channel` | Incident |

Missing or unparsable telemetry for a trigger → that trigger reports **unknown**
(distinct from quiet), exits 2, and names the missing file/schema — degraded data
cannot silently pass.

## 9. Build plan — what must be built / enhanced / improved

Ordered by dependency, each a candidate ticket:

1. **Per-phase usage recording** (issue #272 — the *write* side; `spend.mjs`'s
   read side already exists): P4/P5 recorders populate `usage` per §8a, including
   registry-resolved `provider`/`model`. *Enhance: `prosecute`, `runner`,
   `gate-manifest` record call sites.*
2. **Operator-local registry + `routeJob`** (core): §4b loader (path rule,
   validation rules 1–5), §5 routing with build-class derivation and mislabel
   rejection, consumed by fleet dispatch. *Build: new package (or extend
   `model-router`).*
3. **OpenCode Go wiring + adapter model contract (§4c)**: verify
   `opencode run -m <model>` headless against Go models on both machines; extend
   the opencode and codex adapters to **pass the model argument explicitly and
   surface `resolvedModel`** in their results; point the fleet's blocking
   cross-model prosecution at the opencode adapter via the registry; keep
   fail-closed. *Enhance: `fleet/adapters/opencode.mjs`, `fleet/adapters/codex.mjs`,
   operator config + docs.*
4. **Attestation schema v2 + quorum** (§6): version bump across **every**
   producer and reader — `recordCrossModelReview`, `carryForwardCrossModelReview`
   (quorum-set-preserving carry), `hasCrossModelApprove*`, the new quorum
   verifier — plus the dispatch-time authorship record, recorder mismatch
   rejection, gateway discounting, legacy fail-closed for trust-root, and the
   routine-tier flag day. *Enhance: `prosecute/cross-model.mjs`, `gate-manifest`
   record shape; consumes `multimodel-review.md`'s `--providers`.*
5. **Telemetry producers + monitors** (§8b–c): event writers in the dispatch
   wrapper and fleet merge path, `adlc quartermaster check`. *Build: new package;
   producer-to-monitor round-trip tested.*
6. **Maintenance orchestration contract**: dev-one systemd timer set (nightly scan /
   weekly mining + calibration / monthly ratchet) documented as a versioned
   contract in `docs/integrations/`, with fail-modes (no `ADLC_MANIFEST_KEY`,
   report-only, gh-issue dedup per §8c). *Document + dotfiles; no repo code.*
7. **review-calibration over the new reviewers**: planted-bug recall for each
   reviewer-group member, so quorum membership is evidence-driven. *Enhance:
   `review-calibration` provider config.*
8. **multimodel `--providers` dependency**: quorum engine specified in
   `docs/specs/multimodel-review.md` (separate repo build); §6 defines the consumer
   contract, including gateway discounting. *Track as external dependency.*
9. **Deferred, trigger-gated**: pi adapter headless verification
   (`docs/specs/pi-native-flush.md`); local inference on upgraded hardware; herdr
   phase-3 fleet tabs (observability only).

## 10. Non-goals

- Not an enforcement tier for code changes; gates and rails are untouched.
- No model ever selects a channel at runtime (D0 applies to supply, too).
- Nothing in a candidate tree selects, narrows, or hints channel choice — there is
  deliberately **no** repo-side knob (rev 2's committed half is deleted, not
  restricted).
- No dedicated inference hardware in the reference stack; re-entry is trigger-gated
  (§8), not aspirational.
- Not a billing system: cost classes and thresholds are coarse signals for humans,
  not an accounting ledger.
- The personal-subscription economics doc stays out of the public repo.

## 11. Open questions

1. Package/plugin name: `adlc-quartermaster` vs `adlc-supply` vs folding into
   `model-router` as a `channels` module. (Naming only; seams fixed by §4–§6.)
2. `rateWindow` utilization: sampled pre-flight or observed on collision? Start
   observed-only; pre-flight couples to gateway internals.
3. Cap-hit exit-code classification per subscription harness — probe per harness
   before enabling §8b's `cap-hit` producer; until probed, the cap-hit monitor
   reports **unknown** rather than quiet.
4. **RESOLVED (issue #401) — no separate escalation event.** Escalation is visible
   on the §8a dispatch usage carrier instead: it already exists, is written
   exactly once per dispatch, and already carries `channel`, `transport` and
   `registryDigest`, so it now records the channel that actually ran plus an
   `escalatedFrom` sibling when the strike climbed. A second producer for the
   same fact would invite the double-counting §8a's one-carrier-per-call rule
   exists to prevent, and no §8c monitor consumes a ladder-escalation event —
   §8b's `fallback` covers §7 traversals, and `seatRole: "escalation"` is a
   reviewer-seat property, not this. The transcript header names the channel too,
   so the operator-facing log and the ledger agree. Revisit only if a monitor is
   ever specified that needs escalation *counts* independent of spend.

## 12. Acceptance criteria

1. **No candidate-tree participation in selection.** With a registry file present
   inside the repo under review (any path) and a valid operator-local registry, a
   fleet dry-run dispatches per the operator registry and emits a notice that the
   in-repo file was ignored; with the operator path configured to point inside the
   repo, loading is disabled and dispatch fails closed. Verified by
   `packages/quartermaster/test/registry-isolation.test.mjs` (`assert` on dispatched
   argv, notice text, and fail-closed exit).
2. **Registry validation rules 1–7.** Fixtures: unknown channel name; missing §4a
   channel; adapter not in `packages/fleet/lib/adapters/`; any `command`/argv-shaped
   key; `frontier` and `frontier-metered` sharing a transport; non-gateway
   trust-root member lacking `directAuth`; **a reviewer-group member with
   `model: "default"` or any run-time alias (rejected) vs. a build channel with
   `default` (accepted)**; **an alias-based build channel whose adapter has no
   `modelProviders` entries (rejected — nothing its alias can resolve to is
   mapped) vs. one with a complete table (accepted); a `modelProviders` value
   that is not a normalized provider string (rejected)** — each invalid fixture
   rejected at load with an error naming the rule. Verified by
   `packages/quartermaster/test/registry-validation.test.mjs` (`assert` per fixture).
3. **`routeJob` derivation through the real pipeline.** An end-to-end test loads a
   fixture ticket DAG, runs `@adlc/core`'s `computeFloat`, feeds
   `assignTicket`'s actual output to `routeJob` — no synthetic `float` fields on
   tickets — and asserts: a zero-float ordinary ticket routes `frontier` even when
   assignment tier is `mid`; a zero-float ticket labeled `build.ladder-start` →
   throw; `category: "spec"` labeled `build.critical-path` → throw; an assignment
   with absent/non-numeric `float` → throw (never ladder-start); unknown job →
   throw; `gate.deterministic.*` with a channel assertion → throw; plus the
   table-driven sweep over every §5 row. Verified by
   `packages/quartermaster/test/route-job.test.mjs`.
4. **Quorum with gateway discounting.** A trust-root group of two gateway-transport
   members with distinct declared providers fails validation (one effective
   family); the reference shape (gateway + directAuth) passes; at runtime, one of
   two members unreachable → nonzero exit, under-satisfaction notice, no `approve`
   recorded. Verified by `packages/prosecute/test/quorum.test.mjs` (`assert` on
   validation error, exit code, and notice text).
5. **Attestation schema v2 across all producers and readers.** Recording with a
   `(model, transport)` absent from the registry, or a provider disagreeing with
   the registry binding, throws; a valid record carries `attestationSchema: 2`,
   `provider`, `transport`, `model`, `seatRole`, and the registry SHA-256.
   `carryForwardCrossModelReview` of a quorum-2 approval emits **two** carried v2
   entries preserving each seat's identity fields and naming the one satisfied
   `reviewSetId`; a v1/legacy entry offered to the trust-root quorum verifier is
   rejected (fail closed) while the routine reader still accepts it pre-flag-day.
   **Snapshot atomicity:** an approving gateway seat from review set A (registry
   digest X) plus an approving direct seat from review set B (digest Y) does
   **not** satisfy quorum — the verifier rejects mixed `reviewSetId`s and mixed
   digests even though each seat verifies individually. **Member substitution:**
   a seat recorded by a cheaper model sharing the trust-root member's provider
   and transport (registered in another group) is rejected — it does not match
   the named snapshot member's `(adapter, model, transport)`; likewise a seat
   whose adapter-attested `resolvedModel` (§4c) disagrees with the snapshot
   member is rejected, with an end-to-end case asserting the real adapter argv
   carries the explicit model argument. **Terminal-set semantics:** with approve
   set A then a later `needs-attention` set B on the same revision, the gate
   blocks (newest complete set is authoritative); with B's entries deleted from
   the manifest but the out-of-tree ledger head naming B, verification fails
   closed rather than reverting to A. Verified by new
   cases in `packages/prosecute/test/cross-model.test.mjs` (`assert` on throws,
   entry fields including digest and reviewSetId, carried seat count, both reader
   behaviors, the interleaved-sets rejection, the substitution and resolvedModel
   rejections, adapter argv, and both terminal-set cases). **Partial-head
   cases (round 10):** approve-set A followed by ledger-head set B containing
   one `needs-attention` seat with the second member unreachable → blocked
   (no backward search to A); approve-set A followed by head set B with one
   approving seat but under quorum → blocked. Both asserted in the same test
   file.
6. **Two-phase author binding through a real dispatch.** An end-to-end test
   dispatches a worker (phase-1 provenance signed, keyed `{runId, ticket,
   attempt}`, no revision), lets it **edit the worktree**, computes the actual
   post-build change-set revision, and signs the phase-2 binding; the verifier
   then resolves author family `openai` via binding → provenance, and a
   prosecution invoked with `--author-provider anthropic` still fails quorum when
   the direct-auth seat is an `openai` reviewer — the flag is recorded as
   non-gating metadata. A fleet-origin revision with a provenance record but
   **no phase-2 binding** fails closed (asserted author not accepted). A
   non-fleet revision carries `authorIdentity: "asserted"`. **Provenance
   deletion fails closed:** with the out-of-tree run ledger naming the revision,
   deleting **all** branch-carried provenance and binding records still fails the
   gate (the ledger is authoritative for fleet origin; absence of in-tree records
   is never read as human authorship). **Set-valued authorship and lineage:** a
   composite revision with contributing dispatches from two provider families
   excludes reviewers of **both** families from quorum seats; a one-byte
   amendment on top of a fleet lineage head — whose exact revision is absent
   from the ledger — is still classified fleet-origin and fails closed without a
   signed human-takeover record, and passes the asserted path only after one is
   written. Verified by
   `packages/prosecute/test/author-binding.test.mjs` (`assert` on quorum failure,
   fail-closed gate, deletion-case fail-closed, both-family exclusion, the
   amendment lineage case with and without takeover, metadata field, and
   asserted-provenance marker — no pre-matched fixture records). **Ancestry
   anchor cases run against real git history** (no synthetic ledger rows): an
   amendment committed on top of a recorded `resultCommit` is classified
   fleet-origin via commit-graph ancestry; a dirty tree on that HEAD inherits
   the classification; **a rebase of the fleet commit onto a moved base — old
   object still resolvable — is classified fleet-origin via the patch-id
   bridge, as is a cherry-pick of it**; **a cherry-pick of the fleet commit
   with a one-byte modification on an overlapping path — matching neither
   ancestry nor patch-id — is AMBIGUOUS and fails closed until a signed
   human-takeover record exists (the overlap classifier)**; **a cherry-pick
   whose content is MOVED to a new path and edited (rename/copy + one-byte
   change) still fails closed — path sets are rename/copy-aware and include
   source and destination**; **a COPY that leaves the source unchanged and
   edits only the destination also fails closed (exhaustive copy detection /
   `--find-copies-harder` semantics), and a run where copy detection is
   skipped or exhausted fails closed rather than proceeding partially**;
   **the reference `frontier` channel end-to-end: a claude-code dispatch with
   alias `default` yields an adapter-attested `resolvedModel` mapped through
   `modelProviders` into the phase-2 contributor entry (assert the concrete
   model and provider in the binding)**; **a build-alias resolution whose attested
   concrete model is absent from the registry's `modelProviders` table fails
   closed rather than falling back to the phase-1 declared provider**; a squash-merge
   fixture is fleet-origin only after the merge path records the post-squash
   lineage head; a shallow clone where the `resultCommit` object is
   unavailable fails closed; **author-family exclusion resolves from the
   phase-2 per-contributor `resolvedAuthor` mapping: a build alias whose
   attested resolution differs in family from the phase-1 declaration
   excludes the RESOLVED family (declared-anthropic-resolves-openai must
   exclude openai reviewers), a composite whose two contributors resolve to
   two different families excludes BOTH resolved families, and a binding
   missing any contributor's resolution — or with a dispatch not covered by
   exactly one contributor entry — fails closed**. Verified by additional
   cases in `packages/prosecute/test/author-binding.test.mjs` (`assert` per
   case against a fixture git repo).
7. **Fallback through the real resolver.** Driving the actual registry loader and
   resolver (not stubs): `prosecute.verdict` with a simulated pre-execution auth
   failure on `frontier` dispatches `frontier-metered`, `assert` the two attempts'
   transports differ, and both usage entries plus one `fallback` event are
   recorded; a mid-run timeout does not traverse; any other job with an
   unreachable channel fails the gate. Verified by
   `packages/quartermaster/test/fallback.test.mjs`.
8. **Usage round-trip with transport filtering.** Entries recorded per §8a — with
   the mandatory `channel`/`transport`/`registryDigest` siblings — flow through
   `aggregateSpend()` and produce nonzero `byPhase` totals for P4/P5 (guarding
   against the rev-2 field-name bug). The overflow monitor, given a mixed fixture
   (same provider/model/tier under `subscription:anthropic-max` and
   `api:anthropic-batch`, plus a second API model at a different price), prices
   **only** the `api:*` entries, per `usage.model`, quoting the `pricing.json`
   version. Verified by
   `packages/gate-manifest/test/usage-roundtrip.test.mjs` (`assert` on totals, on
   subscription-entry exclusion, and on per-model pricing in the finding).
9. **Producer-to-monitor round trips, including producer readiness.** For each §8b
   `kind`, the *producing* code path (dispatch wrapper / fleet merge path) writes
   the record and the corresponding monitor consumes it: a merge + rate-limit
   same-day pair trips the collision trigger; recorded `seatRole:"escalation"`
   attestations suppress the idle-reviewer trigger while ≥5 reviews without them
   fire it; fixtures for each row also cover the non-crossing case (exit 0) and
   missing-file **unknown** (exit 2 naming the file); **readiness transitions:**
   a well-formed events file whose `producer-readiness` interval starts on day 29
   of the 30-day window yields cap-hit = unknown naming the uncovered span (not
   quiet); a disable-on-day-10 / re-enable-on-day-20 pair **on the same transport
   and registry digest** leaves days 10–19 uncovered and yields unknown naming
   that span (restoration never backfills); cap-hit events carrying a
   since-replaced frontier `transport` are excluded after a rebinding (no false
   re-upgrade issue); a second run against an open issue key updates rather than
   duplicates (gh stubbed). Verified by
   `packages/quartermaster/test/check.test.mjs` (`assert` on exit codes, uncovered
   spans in output, transport exclusion, and issue calls).
10. **This spec passes its own gate.** `node packages/spec-lint/bin/spec-lint.mjs
   docs/specs/operating-stack.md` exits 0 (no WISH criteria). Verified by running
   the command in CI; exit code 0 required.
