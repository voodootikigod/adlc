# External Ticketing Sync — Design

**Date:** 2026-06-27
**Status:** Approved design (rev 4, post adversarial review round 3 — cleared to proceed), pending implementation plan
**Author:** Chris Williams (with Claude)

## Problem

ADLC's ticket system is a single local JSON file (`.adlc/tickets.json`, the
`{ "tickets": [...] }` envelope read by `@adlc/core`'s `loadTickets()`). This is
correct for the gates but wrong for end users: teams already run their work in
GitHub Issues, Linear, Jira, etc. We want ADLC to plug into those systems rather
than ask users to maintain a parallel ticket store.

## Goal

Support **two-way sync** between an external ticketing system and ADLC's local
ticket store, **GitHub Issues first**, behind a provider interface so Linear/Jira
can follow. The external tracker becomes the place users author and read work;
ADLC reads tickets, **creates issues for local-only tickets**, and writes
execution outcomes back.

### Non-goals (this iteration)

- Live, on-demand querying of the external API from inside gates (breaks the
  offline contract — see Key Constraint).
- Automatic three-way *content merge* of conflicting block edits (we detect the
  conflict with a stored base and stop; the user resolves).
- Providers other than GitHub (the interface is defined; only GitHub is built —
  no runtime provider registry until a second provider lands).
- A hosted service / webhooks. Sync is explicit and user-invoked.
- `doctor` auto-repair (`--fix`) and remote repair — MVP ships a **read-only,
  offline** doctor; the repair registry is a follow-up spec (see Doctor).

## Key constraint: gates stay offline and synchronous

ADLC's contract: gates run offline, synchronously, no API keys (`loadTickets()`
is `readFileSync`). External systems are network + auth + async.

**Resolution — the git model.** All network/auth I/O lives in explicit commands
(`pull` / `push` / `sync`). Between them everything is offline and synchronous.
The external tracker is the "remote"; `.adlc/tickets.json` is the "working copy".
Gates are unchanged: they keep calling `loadTickets()`. **The only thing pull
must guarantee is that it writes a fully valid local file** (see Validity Gate) —
it does not change `loadTickets()` or any gate.

## Hard constraints discovered in review (must be honored)

These come from `CONVENTIONS.md` and the rails subsystem; violating them is what
the first design draft did wrong.

- **C1 — Zero runtime dependencies** (CONVENTIONS rule 1): "Node 18+ built-ins and
  `@adlc/core` only." → **The block is JSON, parsed with `JSON.parse`.** No YAML
  (Node has no built-in YAML parser; a hand-rolled one on untrusted input is a
  security liability).
- **C2 — Core is frozen** (CONVENTIONS rule 2): "Never edit anything under
  `packages/core/`." → The schema bedrock and the rich validator live in the new
  package, **not** core. There is **no new ticket field** at all: sync metadata
  lives in the sidecar (below), so core's `loadTickets()`/`validateTicket()` are
  untouched and never see sync state.
- **C3 — `.adlc/tickets.json` is the rail trust root.** The PreToolUse hook
  freezes it once any rail exists, and the **CI rails-guard diff gate**
  (`scripts/rails-guard-ci.mjs`) treats the file itself as a protected rail and
  flags **any** change to it — it does **not** consult the gate-manifest, so there
  is **no machine "audited bypass"** for CI. The only path to land a trust-root
  change is the existing one: a human reviews the diff and admin-overrides the
  required check. Therefore: (a) routine sync bookkeeping must NOT live in
  `tickets.json` (it would churn the trust root every run); it lives in a non-rail
  **sidecar**. (b) Real ticket-content changes from sync (new tickets, changed
  rails/scope/edges) intentionally go through that same human-reviewed gate — that
  review IS the protection against a malicious or careless external edit.
- **C4 — `gh` is invoked via `execFile` (argv array), never a shell.** Untrusted
  issue content (titles, bodies, labels) is passed as arguments/stdin, never
  interpolated into a shell string.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Two-way sync, **staged**: schema → block codec → pull → push+create → doctor | Each stage is independently testable; value lands incrementally. |
| D2 | **Provider interface** (documented module shape), GitHub first, **no registry yet** | YAGNI; a registry for one provider is premature indirection. |
| D3 | Transport = **`gh` CLI** via `execFile` | Reuses `gh` auth (like `rejection-mining`); zero npm deps; no shell injection. |
| D4 | Metadata home = **fenced JSON block** in the issue body, between HTML-comment sentinels | Portable, lossless via canonical JSON, zero-dep parse, editor-validatable via a `$schema` key. |
| D5 | **Definition-driven validator + generated JSON Schema**, in the **new package** | One source of truth for the external contract; cannot drift (drift gate). Core stays frozen (C2). |
| D6 | Conflict policy = **3-way detect (base/local/remote), warn-don't-merge**; base stored in the **sidecar** | A stored last-synced base is required to tell "remote changed" from "both changed"; it must not live in the trust root (C3). |
| D7 | **Field ownership** split | Humans own prose/labels; ADLC owns the block, `adlc:` labels, the status comment. |
| D8 | **Create issues for local-only tickets** (push), **idempotent via a stable key**, then **reassign the id to the gh-qualified id** with atomic edge rewrite | Full round-trip; a single id space (D9) avoids dangling-edge corruption; the key prevents duplicate issues on a lost local write. |
| D9 | **Single, repo-qualified id space**, issues-only | `gh:<owner>/<repo>#<number>` is globally unique; PR number-space excluded; one id space so `edge.to` always resolves. |
| D10 | **Labels are display-only**; authoritative state is the local manifest + an **author-verified** status comment | GitHub has no label-namespace ACL; labels/markers are spoofable. |
| D11 | **doctor**: read-only + offline in MVP; repair deferred | Matches pull-first; avoids a cross-package registry and a third remote-write path now. |

## Architecture

### New package: `@adlc/ticket-sync`

Standard ADLC package shape: zero runtime deps (`gh` via `child_process.execFile`),
`--json`, dry-run-by-default, exit codes `0/1/2`.

```
packages/ticket-sync/
  package.json            # @adlc/ticket-sync, zero deps, bin: adlc-ticket-sync
  README.md
  bin/
    ticket-sync.mjs       # CLI: pull | push | sync | doctor ; flags per the matrix below
  lib/
    schema.mjs            # BEDROCK: declarative field definition (tickets + block subset + config)
    validate.mjs          # definition-driven validator (rich schema); + agreement check vs core
    block.mjs             # JSON-block codec: parseBlock(body) / serializeBlock(prose, fields)
    canonical.mjs         # canonical JSON serialization + equality (sorted keys, LF, stable nums)
    provider.mjs          # provider INTERFACE (documented shape) — no registry
    reconcile.mjs         # pure 3-way: reconcile(base, local, remote) -> {merged, conflicts}
    outcomes.mjs          # reduce .adlc/manifest.jsonl -> per-ticket status (latest-per-gate)
    status-render.mjs     # status -> {labels, commentBody} (canonical, timestamp-free)
    config.mjs            # read/validate .adlc/config.json; gh/git repo auto-detect
    store.mjs             # writeTicketsAtomic() + shared lock (re-implemented; see Lock)
    rails-guard-sync.mjs  # rail/scope narrowing detection + forensic override record (NOT a CI bypass)
    doctor.mjs            # read-only offline checks (flat list; MVP)
    gh.mjs                # execFile wrapper for gh (INJECTED into providers/tests)
    providers/
      github.mjs          # mapIssueToTicket / mapTicketToIssue / create/edit/label/comment ops
  schemas/                # generated + committed
    adlc-ticket.schema.json   adlc-block.schema.json   adlc-config.schema.json
  scripts/
    gen-schema.mjs        # emits schemas/*.json from lib/schema.mjs (run on change; CI-checked)
  test/
    schema.test.mjs  validate.test.mjs  block.test.mjs  canonical.test.mjs
    reconcile.test.mjs  github.test.mjs  outcomes.test.mjs  config.test.mjs
    store.test.mjs  rails-guard-sync.test.mjs  doctor.test.mjs  cli.test.mjs
```

**Core is NOT touched.** `loadTickets()`/`validateTicket()` stay as-is; no sync
field is added to tickets (it all lives in the sidecar). To prevent the rich
validator from drifting from core's gate validator, `validate.test.mjs` runs a
shared corpus through **both** `@adlc/core`'s `validateTicket` and the bedrock
validator and asserts agreement on the fields core knows about.

### Provider interface (D2)

A documented module shape (not a registry):

```
pull(ctx)                  -> { issues: RawIssue[] }            // fetch per the selector
createIssue(ctx, ticket)   -> { number, nodeId, url }           // for local-only tickets
updateIssueBody(ctx, ref, body)
ensureLabels(ctx, ref, labels)        // create-if-missing + set the adlc: state label
upsertStatusComment(ctx, ref, body)   // author-verified, marker-anchored
```

`ctx` carries the injected `gh` runner, the repo, and dry-run flag. GitHub is the
only implementation; the interface exists so a second provider has a target.

## The block (D4) — JSON, sentinel-wrapped

The block carries ADLC execution metadata GitHub Issues lack. It is a fenced
`json` block between reserved HTML-comment sentinels. Example issue body (the
prose is human-owned; everything between the sentinels is ADLC-owned):

    Human-authored description goes here (the "prefix" prose).

    <!-- adlc:begin v=1 key=7f3a… -->
    ```json
    {
      "$schema": "https://adlc.dev/schema/v1/adlc-block.schema.json",
      "scope": ["src/**"],
      "rails": ["test/**"],
      "edges": [{ "to": "gh:acme/app#42", "contract": "src/contracts/export.schema.json" }],
      "duration": 2,
      "category": "feature",
      "budget": 200000
    }
    ```
    <!-- adlc:end -->

    More human prose may follow (the "suffix"), also preserved verbatim.

- `id` and `title` are **not** in the block. `title` = issue title;
  `id = "gh:<owner>/<repo>#<number>"` (D9). The sidecar carries the durable refs.
- The schema version (`v=1`) and the create idempotency `key` live on the
  **sentinel** so they are readable without parsing the JSON. `$schema` inside is an
  optional editor-validation hint and is **excluded from canonical equality** (so
  its presence/URL never causes push churn).
- **Body model:** the issue body is `{prefix, block, suffix}`; both prose segments
  are preserved verbatim across round-trips (only the JSON between the sentinels is
  rewritten).
- **Reserved strings:** `<!-- adlc:begin` and `<!-- adlc:end -->` are reserved.
  Exactly one well-formed pair is allowed; zero, multiple, or unbalanced sentinels
  → fail closed with an error naming the offending line (see Validity Gate).

### Sidecar: `.adlc/ticket-sync.state.json` (NOT a rail)

All sync bookkeeping lives in a sidecar so routine syncs never touch the rail
trust root (C3). It is keyed by **ticket id** and is not read by any gate:

```json
{
  "version": 1,
  "tickets": {
    "gh:acme/app#42": {
      "provider": "github", "repo": "acme/app", "number": 42,
      "nodeId": "I_kwDO…",                 // GraphQL node id — stable across transfer/renumber
      "url": "https://github.com/acme/app/issues/42",
      "syncedHash": "<canonical-block-hash at last successful sync>",  // the 3-way BASE (D6)
      "syncedAt": "<iso8601>",
      "createKey": "<uuid>"                 // idempotency key for create (below)
    }
  },
  "pendingCreates": { "<uuid>": { "localId": "T7", "title": "…" } }   // crash-recovery (below)
}
```

- `nodeId` is the durable identity used for matching and re-resolution; reconcile
  matches local↔remote by `nodeId`, falling back to `provider+repo+number`.
- `syncedHash` is the canonical-block hash; it is computed and written **in the same
  atomic sidecar write** as the rest of that sync's state (no second write, no
  desync window). A no-op pull that changes nothing writes nothing.
- The sidecar is mutable, frequently rewritten, and **not** a rail — so ordinary
  sync activity never trips the CI trust-root gate. Only genuine ticket-content
  changes land in `tickets.json`, which is exactly what should be human-reviewed.
- **Persistence: the sidecar is a gitignored, rebuildable cache** (it would churn
  git history and merge badly if committed, and a committed base could be
  pre-seeded). On a fresh clone it is absent. A synced ticket (`gh:` id) with **no
  sidecar entry** is not treated as local-only: its refs are re-derived from the
  `gh:` id and re-fetched to rebuild `nodeId`/`syncedHash` on the next pull.
- **Base integrity is non-authoritative but must fail safe.** The 3-way base
  (`syncedHash`) only powers warn-don't-merge UX; no rail/validity defense depends
  on it. A **missing or unparseable base** must reconcile to **conflict** (require
  `--force`) when local≠remote — never to a silent take-remote. (So tampering with
  or deleting the sidecar can at worst force a conflict prompt, never a silent
  overwrite of local edits.)

## Schema bedrock (D5) — one definition → three artifacts

```
packages/ticket-sync/lib/schema.mjs   <- THE source of truth (plain data, zero deps)
        |--> validate.mjs             <- definition-driven validator (rich)
        |--> gen -> adlc-ticket.schema.json   (full ticket; no sync state)
        |--> gen -> adlc-block.schema.json    (block subset: no id/title)
        |--> gen -> adlc-config.schema.json   (.adlc/config.json)
        +--> gen -> adlc-sync-state.schema.json (.adlc/ticket-sync.state.json sidecar)
```

- `scripts/gen-schema.mjs` emits all three JSON Schemas from the definition.
- **Drift gate** (`schema.test.mjs`): regenerate in-memory and assert the
  committed `.json` files match — same pattern as the release lockfile gate.
- **Cross-validator agreement** (`validate.test.mjs`): asymmetric and scoped —
  every input core's `validateTicket` accepts must also be accepted by the rich
  validator on core's shared fields (the rich validator may additionally enforce id
  format / `category` enum that core ignores; that is not "disagreement").
- **Relational invariants are NOT schema-expressible** and stay in code: duplicate
  ids, edge resolution, cycles. The "one definition" claim is scoped to *per-field*
  validation; relational checks are explicitly code-only (and run at the Validity
  Gate, below).

### Field definition (the bedrock, authoritative)

| Field | Type | Required | Constraints | Owner |
|---|---|---|---|---|
| `id` | string | yes | single space: `gh:<owner>/<repo>#<n>` once synced; `T<n>` only while purely local (reassigned to the gh id on create, D8) | derived |
| `title` | string | yes | from issue title | human |
| `body` | string | no | `{prefix, suffix}` prose around the block, verbatim | human |
| `scope` | string[] | no | globs | ADLC (block) |
| `rails` | string[] | no | path globs (security-relevant) | ADLC (block) |
| `edges` | object[] | no | `{ to: <ticket-id>, contract?: string }`; `to` MUST resolve (else fail closed) | ADLC (block) |
| `duration` | number | no | `> 0`; relative effort | ADLC (block) |
| `category` | string | no | enum: `feature|bug|refactor|docs|chore|spec|contract|architecture` | ADLC (block) |
| `budget` | number | no | `> 0`; token hint | ADLC (block) |

Sync metadata (`origin`/`syncedHash`/etc.) is **not** a ticket field — it lives in
the sidecar (above). The block subset = `scope, rails, edges, duration, category,
budget` + optional `$schema`; `v` and `key` live on the sentinel.

## Validity Gate (applied before any local write)

Pull/create build the full proposed ticket set **in memory**, then it must pass,
atomically, before the file is written (C3-safe — a failed pull never mutates the
file):

1. **Id normalization (single space):** all ticket ids and all `edges[].to` values
   are normalized to the canonical id space (D9) before checking — a block written
   as `gh:acme/app#42` and a local ticket whose sidecar maps to that issue are the
   same key. Normalization is **deterministic and matches `loadTickets` string
   equality**: owner/repo are lowercased (GitHub is case-insensitive but
   case-preserving, so `gh:Acme/App#42` and `gh:acme/app#42` must collapse), and
   whitespace/`#` spelling is canonicalized. There is exactly one id space; no
   `T<n>`↔`gh:` ambiguity survives (created/transferred tickets are reassigned to
   their gh id, D8). **The resolution-checked materialized set is byte-for-byte what
   `writeTicketsAtomic` persists** — so passing the gate guarantees the written file
   cannot crash `computeFloat`.
2. **Relational checks (loadTickets-level):** no duplicate ids; **every `edges[].to`
   must resolve within the materialized set**; no cycles. An edge whose target was
   not pulled → **fail closed (exit 2)** with a message to widen the selector (or
   the tool auto-expands the selection to fetch the referenced issue). It is
   **never** silently dropped — dropping a real dependency/contract is corruption,
   and writing it dangling would crash `computeFloat` (verified).
3. **Block cases:** no block → import title/body only (empty execution fields, not
   an error); valid block → materialize; **present-but-invalid or
   unbalanced-sentinel block → fail closed** (report against that ticket, do not
   materialize, exit `2`). Never degrade a malformed `rails` block to "no rails".
4. Version: sentinel `v` greater than the supported max → fail closed with a clear
   message (do not guess); lower → accept/migrate per a documented table.

Only after all of the above does `store.writeTicketsAtomic()` run.

## Sync vs the rails trust root (C3)

`.adlc/tickets.json` is the rail trust root. The **CI gate
(`scripts/rails-guard-ci.mjs`) does not consult the gate-manifest** — it flags ANY
change to the trust root and there is **no machine bypass** (verified). The design
works *with* that reality rather than pretending to bypass it:

- **Routine syncs do not touch the trust root.** All sync bookkeeping is in the
  sidecar (not a rail). A pull/push that changes no ticket *content* leaves
  `tickets.json` byte-identical, so the CI gate is never involved — this is what
  makes the workflow viable in rails-enabled repos.
- **Ticket-content changes from sync go through the existing human gate, by
  design.** When sync genuinely changes `tickets.json` (a new ticket with rails,
  or changed rails/scope/edges pulled from the tracker), the CI gate flags it and a
  human reviews the diff and admin-overrides the required check — the *same* path as
  any `/adlc-ticket` rail change. There is no new bypass. **That human review is the
  authoritative protection** against a malicious/careless external edit (rail strip,
  scope widening). Caveat (grounded in `rails-guard-ci.mjs`): once rails exist at
  base, `tickets.json` is frozen and every change trips the gate; the **very first**
  rail introduced into a previously rail-less repo is caught by ordinary PR diff
  review, not by the rails-guard check itself. Adding rails only ever *tightens*
  enforcement, so this is not an escalation path.
- **Local defense-in-depth (UX, not the backstop):** before writing, pull computes
  a per-ticket rail/scope diff vs the local set and **refuses** a change that
  *removes or replaces* (not pure-superset-addition) any `rails` or widens `scope`,
  unless `--allow-rail-narrowing` is given. Both directions are defined
  conservatively and decidably as pure string-set tests (no glob-containment):
  **incoming `rails` must be a superset of local `rails`** (removal/replacement →
  flag), and **incoming `scope` must be a subset of local `scope`** (widening →
  flag). This catches the common accident early; the CI+human gate remains the real
  enforcement. The local override is logged to the gate-manifest as forensics (it
  does not make CI pass — nothing does except human review). Note: in a repo with
  **no base rails**, `rails-guard-ci` does not protect `tickets.json`, so for scope
  changes there the local guard + ordinary PR review are the only checks.
- `--force` (block-conflict override) is likewise logged as forensics.

## Data flow

### Pull (external → local)

1. Resolve the selector (below) and fetch **all** matching issues with explicit
   pagination (`gh issue list --limit … --search …`). A capped/truncated fetch
   **fails (exit 1)** rather than risk truncation-driven deletion.
2. For each issue: split body into prose + the sentinel block; parse the JSON.
3. Map issue → ticket: `id = gh:<owner>/<repo>#<n>`; record sync state
   (`nodeId`, refs) in the sidecar.
4. Load current local tickets + sidecar; **3-way reconcile** per ticket using the
   sidecar `syncedHash` as the base (D6): remote-only change → take remote; local-
   only change → keep local; both changed → **conflict → warn + exit 2**
   (`--force` to take remote). If local and remote canonical blocks are *equal*,
   it is converged, not a conflict.
5. Run the **Validity Gate** and the local rail/scope guard. Compute each synced
   ticket's new `syncedHash` and fold it into the materialized set, then **one
   atomic write each**: `writeTicketsAtomic()` for `tickets.json` (only if ticket
   content changed) and an atomic sidecar write (sync state). `syncedHash` is part
   of that single sidecar write — never a second pass.

**Union/deletion semantics:** pull **unions**. Local-only tickets (a `T<n>` id with
no sidecar entry) and synced tickets outside the current selection are preserved
untouched.
A previously-synced issue absent from a *full* selection is **not auto-deleted**;
it is reported (and, in the deferred online doctor, flagged as orphaned). Closed
issues are synced (status reflects closed) unless the selector excludes them.

### Issue selector (config)

`.adlc/config.json` (schema-validated):

```json
{
  "ticketSync": {
    "provider": "github",
    "repo": "acme/app",
    "select": { "state": "open", "labels": ["adlc"], "query": null },
    "createLabel": "adlc",
    "statusLabels": { "p5-pass": "adlc:passed", "p5-fail": "adlc:failed", "wip": "adlc:in-progress" }
  }
}
```

Default selector: **issues whose body contains an `adlc:begin` sentinel** OR carry
the configured `select.labels`, `state=open`. `repo` auto-detected from the git
remote / `gh repo view` when omitted. (Multi-repo is future; `repo` is single for
MVP but ids are already repo-qualified, so multi-repo needs no id change later.)

### Push (local → external) — update + create (D8), idempotent

1. **Update** each ticket already in the sidecar: re-serialize its block (canonical
   JSON) between the sentinels, preserving `{prefix, suffix}` prose verbatim — only
   if the canonical block changed.
2. **Create** each local-only ticket (a `T<n>` id with no sidecar entry) that
   matches the create policy, **idempotently**:
   a. Generate/reuse a stable `key` (uuid) and record a `pendingCreates[key]` entry
      in the sidecar **before** the remote call (crash recovery).
   b. **Pre-create adoption scan:** scan the **already-paginated pull list** of
      issue bodies (authoritative, not the eventually-consistent search index) for
      the sentinel `key`. If exactly one matches → adopt it. **>1 match → fail
      closed (exit 2)**, human reconciles (never adopt-arbitrary or create-a-third).
   c. Else `gh issue create` with the block sentinel embedding `key=<uuid>`; then,
      **immediately and before id-reassignment**, persist the returned
      `{nodeId, number}` into `pendingCreates[key]` (one tiny atomic sidecar write)
      so a crash here leaves a non-spoofable recovery handle (`nodeId`), not just
      the body `key`.
   d. **Reassign the ticket id** from `T<n>` to `gh:<owner>/<repo>#<n>`, **rewrite
      every `edges[].to` across the store** that referenced the old id, **migrate
      `.adlc/manifest.jsonl` evidence** recorded under the old id to the new id (so
      a ticket that passed locally as `T7` keeps its status), record sync state,
      clear `pendingCreates[key]`, and do the atomic writes (single id space,
      D8/D9). *MVP assumes a single writer; concurrent create from two machines is
      out of scope and noted.*
3. **Status** (D10): from `outcomes.mjs` (reduction of `.adlc/manifest.jsonl`:
   latest entry per gate; "verdict" = latest P5 entry; **no P5 entry → no pass
   label**, never fabricated). Rendered to (a) `adlc:` **labels** (mutually
   exclusive within `statusLabels`; created-if-missing) and (b) a single **status
   comment** (canonical, timestamp-free body, anchored by `<!-- adlc:status -->`).
   Both are **display-only, never authoritative** — no gate or doctor reads them for
   a decision (the manifest is the source of truth). The author check (comment
   author == authenticated user) only excludes *other identities*; it does not
   defend against co-holders of the same token (e.g. a shared CI bot). Integrity
   comes from **convergence** (the next push overwrites drift), not from trusting
   the comment.
4. Issues resolved by the sidecar `nodeId`; a transferred/renumbered issue keeps
   its `nodeId` but its `gh:` id string changes → it runs the **same
   reassign + edge-rewrite + manifest-migrate + Validity** path as create (step 2d),
   so edges never dangle after a transfer. **Locked/closed** issue → push reports it
   and skips (bounded; no infinite retry).
5. Dry-run by default; `--write` performs all mutations. Partial failure → per-
   issue result list, exit `1`; re-run is idempotent (canonical block + stable
   labels + author-anchored comment converge).

### Field ownership (D7)

- Human-owned: issue title, `{prefix, suffix}` prose around the sentinel,
  non-`adlc:` labels.
- ADLC-owned: the sentinel block, `adlc:` labels, the status comment.
- Conflicts are detected 3-way (D6); never auto-merged.

## Lock + atomic write (re-implemented — nothing to reuse)

The `/adlc-ticket` "protocol" is **LLM prose, not code**, and core has no writer.
`store.mjs` implements `writeTicketsAtomic()`:

- Acquire `.adlc/tickets.lock` via `mkdir` (the **same** directory-lock path and
  semantics the `/adlc-ticket` command documents, so the two writers interoperate
  and never corrupt each other), with bounded retry then abort (exit 1).
- Write to a temp file, `fsync`, atomic `rename` over `tickets.json`, release lock.
- A mkdir lock has no holder PID; doctor's stale-lock check is **age-guarded only**
  and documented as such. (When core eventually exposes a shared writer, both
  callers migrate; until then this is the single implementation in this package.)

## Flag matrix (coherent)

| Command | Default | `--write` | `--force` | other |
|---|---|---|---|---|
| `ticket pull` | dry-run (print plan/diff) | apply local write | resolve block conflict by taking **remote** (logged forensically) | `--allow-rail-narrowing` (logged) |
| `ticket push` | dry-run (print remote ops) | perform remote edits/creates/labels/comment | — | — |
| `ticket sync` | dry-run | pull then push | as pull | composes pull flags |
| `ticket doctor` | read-only (always) | — | — | `--json` |

`--json` on all. Exit: `0` ok · `1` operational (gh missing/auth/network/lock/
truncation) · `2` blocked (validity fail, conflict, rail-narrowing without flag).

## Security

- **C4** `execFile` argv only; no shell; untrusted content never interpolated.
- **Rails/scope:** the real protection against a malicious external edit (rail
  strip, scope widen) is that it lands in `tickets.json` and goes through the CI +
  human-review gate (see "Sync vs the rails trust root"). The local narrowing guard
  is early UX, not the backstop. (First rail into a rail-less repo is caught by
  ordinary PR review, not rails-guard-ci; once rails exist, every trust-root change
  trips the gate.)
- **Labels + status comment are display-only (D10):** nothing trusts them for a
  decision; the local manifest is authoritative. The comment author check excludes
  other identities but not co-holders of the token; integrity is by convergence.
- **Token scope:** document the minimum — pull needs issues:read, push needs
  issues:write; prefer a fine-grained PAT over full `repo`. Support `GH_HOST`
  (Enterprise). `push` does a pre-flight permission probe and fails early (exit 1)
  if write scope is missing.
- **Audit/observability:** every remote mutation (create/edit/label/comment) and
  every local override is logged (`--json` output + gate-manifest forensics) with
  what changed.

## `doctor` — read-only, offline (MVP) (D11)

A flat list of offline checks; exit `2` if any error, else `0`. **No `--fix`, no
network, no registry in MVP** (those move to a follow-up spec once real drift
patterns are observed):

- `.adlc/config.json` present + valid against `adlc-config.schema.json`.
- `tickets.json` loads (via `loadTickets`) with no errors (dup id / dangling edge /
  cycle / schema). (Unresolved edges are impossible post-pull since pull fails
  closed on them; this catches hand-edits.)
- Committed JSON Schemas == regenerated (bedrock drift).
- Sidecar (`.adlc/ticket-sync.state.json`) valid; no two ticket ids map to one
  `nodeId`; every synced ticket has a `syncedHash`; no stale `pendingCreates`
  (a leftover entry means a create may have orphaned a remote issue — flag it).
- Stale `.adlc/tickets.lock` (age-guarded; reported, not removed).

Deferred to the follow-up doctor spec: the check **registry**, `--fix` (local
repair), `--fix --write` (remote repair), and all **online** checks (remote drift,
orphaned origin, incomplete push).

## Testing (offline, per ADLC contract)

100% of logic runs offline — the only code touching `gh` is `providers/github.mjs`
via the **injected `gh` runner**; tests feed canned `--json` fixtures.

- `schema.test.mjs` — drift gate (committed == regenerated); schemas valid.
- `validate.test.mjs` — rich validator corpus; **agreement with core's
  `validateTicket`** on shared fields.
- `block.test.mjs` — parse/serialize; missing/duplicate/unbalanced sentinels;
  prose containing a fence or sentinel string; present-but-invalid → fail closed;
  `v` too high → fail closed; `$schema` ignored by equality.
- `canonical.test.mjs` — sorted-key/LF/number normalization; CRLF-insensitive
  equality; idempotent re-serialize.
- `reconcile.test.mjs` — 3-way base/local/remote (remote-only, local-only, both-
  changed → conflict; both-changed-to-equal → converged, NOT a conflict);
  local-only ticket survives pull; out-of-selection survives.
- `github.test.mjs` — `mapIssueToTicket` from fixtures; create/edit/label/comment
  op construction; **idempotency**: push twice against a recording fake → second
  run makes no mutating calls; **create idempotency**: pre-create search adopts an
  existing keyed issue; a re-run after a simulated lost local write does NOT
  duplicate; id reassignment rewrites edge references; transferred issue re-resolved
  by nodeId.
- `outcomes.test.mjs` — manifest reduction: multiple verdicts (latest wins), none
  (no fabricated pass), per-gate latest.
- `validity.test.mjs` — id normalization unifies `T<n>`/`gh:` spellings; an
  unresolved `edges[].to` **fails closed** (not dropped).
- `rails-guard-sync.test.mjs` — narrowing/scope-widen detection (superset rule);
  refuse without flag; forensic log written; behavior when manifest unwritable.
- `store.test.mjs` — atomic write; lock acquire/retry/abort; interop with a held
  lock; sidecar `pendingCreates` crash-recovery path.
- `config.test.mjs`, `doctor.test.mjs`, `cli.test.mjs` — schema validity, the
  offline checks, flag matrix + exit codes.

Target 80%+; TDD throughout. **Per-stage acceptance criteria** are defined in
Staging. The single untested edge is the thin real-`gh` runner; it gets one
**opt-in live smoke test** (env-gated, like `codex-install-smoke`), not part of
the default offline suite.

## Implementation staging (each stage = its own plan + acceptance bar)

1. **Schema bedrock** — `schema.mjs`, `validate.mjs`, `canonical.mjs`, generator,
   committed schemas, drift gate, core-agreement test. *Accept:* `npm test` green;
   editing the definition without regenerating fails CI.
2. **Block codec** — `block.mjs` (+ sentinel/fail-closed rules). *Accept:*
   round-trip + all fail-closed cases covered.
3. **Pull** — `gh.mjs`, `providers/github` (read), `reconcile` (3-way), `config`,
   `store`, `rails-guard-sync`, Validity Gate, `adlc ticket pull`. *Accept:* import
   real fixture issues; union/conflict/rail-narrowing behaviors tested; dry-run
   default.
4. **Push + create** — `outcomes`, `status-render`, create/update/label/comment,
   `adlc ticket push`/`sync`. *Accept:* idempotent push (no-op second run); create
   reassigns the id + rewrites edges + records sidecar state, with no duplicate on a
   simulated lost write; manifest evidence migrates with the id; status reduction
   correct.
5. **Doctor (read-only)** — offline checks + `adlc ticket doctor`. *Accept:* each
   check has a failing+passing fixture; exit codes correct.
6. **Docs + opt-in live smoke** — README, `docs/ticket-sync.md`, a synced-ids +
   sidecar note in `docs/ticket-authoring.md`, env-gated real-`gh` smoke.
   *Accept:* docs match flags; smoke documented as opt-in.

## Open / deferred items

- **doctor repair** (registry, `--fix`, `--fix --write`, online checks) — own spec.
- **Multi-repo** selection — own follow-up; ids are already repo-qualified.
- **Second provider** (Linear/Jira) — implement against the provider interface; add
  a registry then.
- **Schema `$id` hosting** — the `https://adlc.dev/schema/v1/…` URL must be stably
  published (or pinned to a release tag) before it is advertised for editor use; it
  is optional in the block and excluded from equality, so it never blocks sync.
- **`prosecute` direct read** of `tickets.json` — optional cleanup to route through
  `loadTickets()`; out of MVP scope.
