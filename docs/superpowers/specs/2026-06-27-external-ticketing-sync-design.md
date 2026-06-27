# External Ticketing Sync — Design

**Date:** 2026-06-27
**Status:** Approved design (rev 2, post adversarial review), pending implementation plan
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
  package, **not** core. `origin` rides along on tickets because core's
  `validateTicket()` ignores unknown fields (verified).
- **C3 — `.adlc/tickets.json` is the rail trust root.** The PreToolUse hook
  freezes it once any rail exists, and the **CI rails-guard diff gate** rejects an
  un-audited change to it. Any writer of that file (pull/push/create) must
  reconcile with this (see Sync vs the rails trust root).
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
| D6 | Conflict policy = **3-way detect (base/local/remote), warn-don't-merge** | A stored last-synced base is required to tell "remote changed" from "both changed". |
| D7 | **Field ownership** split | Humans own prose/labels; ADLC owns the block, `adlc:` labels, the status comment. |
| D8 | **Create issues for local-only tickets** (push), matched by `origin` | Full round-trip; ids do not churn (local id kept, `origin` attached). |
| D9 | **Repo-qualified ids**, issues-only | `gh:<owner>/<repo>#<number>` is globally unique; PR number-space excluded. |
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
    rails-guard-sync.mjs  # rail-narrowing detection + audited gate-manifest bypass record
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

**Core is NOT touched.** `loadTickets()`/`validateTicket()` stay as-is; `origin`
is an unknown field they ignore. To prevent the rich validator from drifting from
core's gate validator, `validate.test.mjs` runs a shared corpus through **both**
`@adlc/core`'s `validateTicket` and the bedrock validator and asserts they agree
on the fields core knows about.

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

    Human-authored description goes here.

    <!-- adlc:begin v=1 -->
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

- `id` and `title` are **not** in the block. `title` = issue title;
  `id = "gh:<owner>/<repo>#<number>"` (D9). `origin` (below) carries the durable refs.
- The schema version lives on the **sentinel** (`v=1`) so it is readable without
  parsing the JSON; `$schema` inside is an optional editor-validation hint and is
  **excluded from canonical equality** (so its presence/URL never causes push churn).
- **Reserved strings:** `<!-- adlc:begin` and `<!-- adlc:end -->` are reserved.
  Exactly one well-formed pair is allowed; zero, multiple, or unbalanced sentinels
  → fail closed (see Validity Gate). A `json` fence inside human prose is ignored
  (only content inside the sentinels is parsed).

### `origin` (rides on the ticket; ignored by core)

```
origin: {
  provider: "github",
  repo: "acme/app",
  number: 42,
  nodeId: "I_kwDO…",        // GraphQL node id — stable across transfer/renumber (C-transfer)
  url: "https://github.com/acme/app/issues/42",
  syncedHash: "<canonical-block-hash at last successful sync>",   // the 3-way BASE (D6)
  syncedAt: "<iso8601>"
}
```

`url` is derived/display-only; `nodeId` is the durable identity used for matching
and re-resolution. Reconcile matches local↔remote by `origin.nodeId` (falling back
to `provider+repo+number`), **never by id string** — so a locally-authored `T7`
that gets an issue created keeps id `T7` and simply gains `origin`.

## Schema bedrock (D5) — one definition → three artifacts

```
packages/ticket-sync/lib/schema.mjs   <- THE source of truth (plain data, zero deps)
        |--> validate.mjs             <- definition-driven validator (rich)
        |--> gen -> adlc-ticket.schema.json   (full ticket incl. origin)
        |--> gen -> adlc-block.schema.json    (block subset: no id/title/origin)
        +--> gen -> adlc-config.schema.json   (.adlc/config.json)
```

- `scripts/gen-schema.mjs` emits all three JSON Schemas from the definition.
- **Drift gate** (`schema.test.mjs`): regenerate in-memory and assert the
  committed `.json` files match — same pattern as the release lockfile gate.
- **Cross-validator agreement** (`validate.test.mjs`): a corpus runs through both
  core's `validateTicket` and the rich validator; they must agree on core's fields.
- **Relational invariants are NOT schema-expressible** and stay in code: duplicate
  ids, edge resolution, cycles. The "one definition" claim is scoped to *per-field*
  validation; relational checks are explicitly code-only (and run at the Validity
  Gate, below).

### Field definition (the bedrock, authoritative)

| Field | Type | Required | Constraints | Owner |
|---|---|---|---|---|
| `id` | string | yes | `gh:<owner>/<repo>#<n>` for synced; `T<n>` for local | derived/local |
| `title` | string | yes | from issue title | human |
| `body` | string | no | prose above the sentinel | human |
| `scope` | string[] | no | globs | ADLC (block) |
| `rails` | string[] | no | path globs (security-relevant) | ADLC (block) |
| `edges` | object[] | no | `{ to: <ticket-id>, contract?: string }`; `to` must resolve | ADLC (block) |
| `duration` | number | no | `> 0`; relative effort | ADLC (block) |
| `category` | string | no | enum: `feature|bug|refactor|docs|chore|spec|contract|architecture` | ADLC (block) |
| `budget` | number | no | `> 0`; token hint | ADLC (block) |
| `origin` | object | no (required once synced) | shape above | ADLC |

(The block subset = `scope, rails, edges, duration, category, budget` + optional
`$schema`. `v` lives on the sentinel.)

## Validity Gate (applied before any local write)

Pull/create build the full proposed ticket set **in memory**, then it must pass,
atomically, before the file is written (C3-safe — a failed pull never mutates the
file):

1. Each ticket passes the rich per-field validator.
2. **Relational checks (loadTickets-level):** no duplicate ids; every `edges[].to`
   resolves **within the materialized set**; no cycles. A block referencing a
   not-pulled ticket → that edge is **dropped with a warning** (never written as a
   dangling edge, which would crash `computeFloat`); the drop is surfaced by doctor.
3. **Block cases:** no block → import title/body only (empty execution fields, not
   an error); valid block → materialize; **present-but-invalid or
   unbalanced-sentinel block → fail closed** (report against that ticket, do not
   materialize, exit `2`). Never degrade a malformed `rails` block to "no rails".
4. Version: sentinel `v` greater than the supported max → fail closed with a clear
   message (do not guess); lower → accept/migrate per a documented table.

Only after all of the above does `store.writeTicketsAtomic()` run.

## Sync vs the rails trust root (C3)

`.adlc/tickets.json` is the rail trust root. Sync writes it from outside the
PreToolUse hook, so the in-session hook does not block it — but the **CI
rails-guard diff gate** will reject the committed change unless it is audited.
Therefore:

- Every sync write that changes rails records a `rails-bypass` entry to the
  gate-manifest (mirroring `/adlc-ticket`), so the committed diff is auditable.
  If the manifest can't be written, the write is refused (fail closed), exactly
  like the hook's audited bypass.
- **Rail-narrowing guard:** pull compares incoming `rails` per ticket against the
  current local `rails`. If any rail is **removed or narrowed**, pull refuses
  unless `--allow-rail-narrowing` is given, and that override is **always audited**
  (independent of `--force`). Rationale: a malicious or careless issue edit that
  strips `rails` must not silently weaken local enforcement.
- `--force` (block-conflict override) writes a gate-manifest audit entry with the
  prior/incoming block diff; refused if the manifest is unwritable.

## Data flow

### Pull (external → local)

1. Resolve the selector (below) and fetch **all** matching issues with explicit
   pagination (`gh issue list --limit … --search …`). A capped/truncated fetch
   **fails (exit 1)** rather than risk truncation-driven deletion.
2. For each issue: split body into prose + the sentinel block; parse the JSON.
3. Map issue → ticket: `id = gh:<owner>/<repo>#<n>`, attach `origin` (incl.
   `nodeId`).
4. Load current local tickets; **3-way reconcile** per ticket using
   `origin.syncedHash` as the base (D6): remote-only change → take remote; local-
   only change → keep local; both changed → **conflict → warn + exit 2**
   (`--force` to take remote, audited).
5. Run the **Validity Gate**, apply the **rail-narrowing guard**, then
   `writeTicketsAtomic()`. Update each synced ticket's `origin.syncedHash`/`syncedAt`.

**Union/deletion semantics:** pull **unions**. Local-only tickets (no `origin`)
and `origin` tickets outside the current selection are preserved untouched.
A previously-synced issue absent from a *full* selection is **not auto-deleted**;
doctor flags it as orphaned. Closed issues are synced (status reflects closed)
unless the selector excludes them.

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

1. **Update** each ticket that has `origin`: re-serialize its block (canonical
   JSON) into the issue body between sentinels (prose preserved verbatim via span
   extraction), only if the canonical block changed.
2. **Create** each local-only ticket (no `origin`) that matches the create policy:
   `gh issue create` with `title`/prose/serialized block; on success attach
   `origin` (incl. `nodeId`) and `writeTicketsAtomic()` (the id stays `T<n>`).
3. **Status** (D10): from `outcomes.mjs` (reduction of `.adlc/manifest.jsonl`:
   latest entry per gate; "verdict" = latest P5 entry; **no P5 entry → no pass
   label**, never fabricated). Render to (a) `adlc:` **labels** (mutually exclusive
   within the `statusLabels` set; created-if-missing; **display-only**) and (b) a
   single **status comment** with a canonical, timestamp-free body, anchored by
   `<!-- adlc:status -->` **and** authored by the authenticated `gh` user. Locating
   the comment requires marker AND author match — a spoofed marker comment by
   another user is ignored.
4. Issues resolved by `origin.nodeId`; transferred/renumbered issues are
   re-resolved via the node id. **Locked/closed** issue → push records a doctor
   finding and skips (bounded; no infinite retry).
5. Dry-run by default; `--write` performs all mutations. Partial failure → per-
   issue result list, exit `1`; re-run is idempotent (canonical block + stable
   labels + author-anchored comment converge).

### Field ownership (D7)

- Human-owned: issue title, prose above the sentinel, non-`adlc:` labels.
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
| `ticket pull` | dry-run (print plan/diff) | apply local write | resolve block conflict by taking **remote** (audited) | `--allow-rail-narrowing` (audited) |
| `ticket push` | dry-run (print remote ops) | perform remote edits/creates/labels/comment | — | — |
| `ticket sync` | dry-run | pull then push | as pull | composes pull flags |
| `ticket doctor` | read-only (always) | — | — | `--json` |

`--json` on all. Exit: `0` ok · `1` operational (gh missing/auth/network/lock/
truncation) · `2` blocked (validity fail, conflict, rail-narrowing without flag).

## Security

- **C4** `execFile` argv only; no shell; untrusted content never interpolated.
- **Rails:** narrowing guard + audited bypass (above) close the malicious-edit path.
- **Labels are display-only (D10):** no doctor/consumer trusts a label for a gate
  decision; authoritative state is the local manifest + the author-verified comment.
- **Status comment** trusted only when authored by the authenticated `gh` user.
- **Token scope:** document the minimum — pull needs issues:read, push needs
  issues:write; prefer a fine-grained PAT over full `repo`. Support `GH_HOST`
  (Enterprise). `push` does a pre-flight permission probe and fails early (exit 1)
  if write scope is missing.
- **Audit/observability:** every remote mutation (create/edit/label/comment) and
  every audited local override is logged (gate-manifest and `--json` output) with
  what changed.

## `doctor` — read-only, offline (MVP) (D11)

A flat list of offline checks; exit `2` if any error, else `0`. **No `--fix`, no
network, no registry in MVP** (those move to a follow-up spec once real drift
patterns are observed):

- `.adlc/config.json` present + valid against `adlc-config.schema.json`.
- `tickets.json` loads (via `loadTickets`) with no errors (dup id / dangling edge /
  cycle / schema).
- Committed JSON Schemas == regenerated (bedrock drift).
- Local block integrity: balanced sentinels, parseable JSON, supported `v`.
- `origin` consistency: no two tickets share one `origin.nodeId`; synced tickets
  have a `syncedHash`; dropped-edge warnings from the last pull surfaced.
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
  changed → conflict); local-only ticket survives pull; out-of-selection survives.
- `github.test.mjs` — `mapIssueToTicket` from fixtures; create/edit/label/comment
  op construction; **idempotency**: push twice against a recording fake → second
  run makes no mutating calls; transferred issue re-resolved by nodeId.
- `outcomes.test.mjs` — manifest reduction: multiple verdicts (latest wins), none
  (no fabricated pass), per-gate latest.
- `rails-guard-sync.test.mjs` — narrowing detection; refuse without flag; audited
  bypass record; refuse if manifest unwritable.
- `store.test.mjs` — atomic write; lock acquire/retry/abort; interop with a held
  lock.
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
   attaches origin without id churn; status reduction correct.
5. **Doctor (read-only)** — offline checks + `adlc ticket doctor`. *Accept:* each
   check has a failing+passing fixture; exit codes correct.
6. **Docs + opt-in live smoke** — README, `docs/ticket-sync.md`, `origin` note in
   `docs/ticket-authoring.md`, env-gated real-`gh` smoke. *Accept:* docs match
   flags; smoke documented as opt-in.

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
