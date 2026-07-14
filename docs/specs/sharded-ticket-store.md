# Spec — Sharded ticket store and ticket domain (`@adlc/tickets`)

**Status:** Approved design; implementation pending

**Date:** 2026-07-13

**ADLC phase:** P1

**Decision record:** [ADR-0010](../adr/0010-sharded-ticket-store.md)

**Tracking:** [implementation epic #179](https://github.com/voodootikigod/adlc/issues/179)

## 1. Objective

Replace `.adlc/tickets.json` with a Git-native directory of independently mergeable
ticket shards while preserving ADLC's fail-closed rails, offline operation, Git review,
external synchronization, and deterministic evidence.

The implementation MUST centralize ticket persistence and mutation in a new
zero-dependency `@adlc/tickets` package. All normative terms (`MUST`, `MUST NOT`,
`SHOULD`, `MAY`) are requirements for store format version 1 unless explicitly scoped
to the 1.x compatibility bridge.

## 2. Non-goals

- Implementing a Dolt backend.
- Installing a Git merge driver.
- Changing protected-base authorization policy.
- Normalizing `status`, `completed`, IDs, arrays, or other ticket content during
  migration.
- Supporting parallel ticket writers in one worktree.
- Adding automatic telemetry.
- Optimizing beyond 1,000 active tickets before measurement.

## 3. Terminology

- **Active store:** tracked `.adlc/tickets/`; the executable P0–P6 contract and trust
  root.
- **Archive:** tracked `.adlc/ticket-archive/`; durable historical shards excluded from
  active gates.
- **Legacy store:** tracked `.adlc/tickets.json` envelope used during the 1.x bridge and
  as migration input thereafter.
- **Shard:** one direct JSON ticket object stored as one regular file.
- **Snapshot:** immutable, completely validated logical view of all active tickets.
- **Ticket hash:** backend-independent SHA-256 of one canonical logical ticket.
- **Store hash:** backend-independent SHA-256 of the canonical active ticket set.
- **Protected ticket:** a ticket present on the trusted base revision.
- **Transaction:** one expected-snapshot mutation applied through the store journal.

## 4. On-disk formats

### 4.1 Active store

```text
.adlc/tickets/
  .store.json
  <slug>--<sha256(id)>.json
```

`.store.json` MUST be exactly the logical object:

```json
{
  "format": "adlc-ticket-directory",
  "version": 1
}
```

Key order and whitespace are not semantic. The manifest MUST NOT contain ticket IDs,
counts, order, hashes, timestamps, writer versions, or other routinely changing data.

Every other entry MUST be a regular `.json` shard at the directory root. Nested
directories, symlinks, sockets, devices, FIFOs, and unrecognized files invalidate the
store. The directory itself MUST be a real directory inside the worktree, not a symlink.

### 4.2 Shard contents

A shard contains the ticket object directly:

```json
{
  "id": "T-01K0Z8M6D7AF6H2VT3QX91NCE",
  "title": "Implement the ticket store",
  "body": "Self-contained work and verification contract.",
  "scope": ["packages/tickets/**"],
  "rails": ["packages/tickets/test/**"],
  "edges": []
}
```

There is no shard envelope or per-shard format version. Unknown fields MUST survive
load/write round trips. Official writers serialize UTF-8 with LF newlines, two-space
indentation, deterministic recursive object-key ordering, preserved array order, and one
trailing newline. Unchanged shards MUST remain byte-identical during unrelated writes.

### 4.3 Filenames

The filename algorithm is normative:

1. Read the exact Unicode ticket ID; do not case-fold it for identity.
2. Produce a display slug by Unicode normalization for display, lowercase conversion,
   replacement of non-ASCII-alphanumeric runs with `-`, trimming separators, and
   truncation to 48 ASCII characters. Use `ticket` if empty.
3. Compute lowercase hexadecimal SHA-256 over the exact UTF-8 ID bytes.
4. Emit `<slug>--<64 hex>.json`.

The hash, not the slug, binds the path to the ID. Loading MUST recompute and compare the
complete expected filename. Case-insensitive collisions or two paths containing the
same ID invalidate the store.

### 4.4 Archive

```text
.adlc/ticket-archive/
  .store.json
  <slug>--<sha256(id)>.json
```

Archive `.store.json` is:

```json
{
  "format": "adlc-ticket-archive",
  "version": 1
}
```

Newly archived tickets add:

```json
{
  "_adlcArchive": {
    "version": 1,
    "archivedAt": "2026-07-13T12:00:00.000Z",
    "reason": "completed",
    "ticketHash": "<pre-archive ticket hash>",
    "sourceStoreHash": "<pre-archive active store hash>",
    "sourceRevision": "<git revision when available>"
  }
}
```

The archive is command-owned and tracked but is not part of the active trust root or
active store hash. Normal gates MUST NOT scan the full archive. Creation MUST perform an
O(1) deterministic-path collision check against the archive. `doctor --archive` MAY
perform full archive validation.

Active tickets MUST NOT point to archived IDs. Archiving MUST fail when it would create
an active-to-archived edge. Archived outgoing edges remain historical only. Restore MUST
remove `_adlcArchive`, verify its recorded hash, reject active ID collisions, and validate
the complete prospective active graph.

Legacy `tickets.archive.json` remains importable. Existing legacy `archivedAt` and
`archiveReason` fields are preserved without implicit normalization.

### 4.5 Runtime state

Locks, journals, staged files, backups, evidence, current-ticket state, and sync sidecars
remain gitignored and outside `.adlc/tickets/` and `.adlc/ticket-archive/`.
`node --test packages/tickets/test/runtime-layout.test.mjs` verifies the boundary.
Recommended locations are:

```text
.adlc/tickets.lock/
.adlc/ticket-transactions/<transaction-id>/
.adlc/current-ticket.json
.adlc/ticket-sync.state.json
```

**Verify:** `node --test packages/tickets/test/runtime-layout.test.mjs` asserts every
runtime path is ignored, outside both tracked stores, and rejected if planted inside
either store.

## 5. Identity

Existing IDs are accepted unchanged. Automatic local creation MUST use a collision-
resistant `T-<ULID>` identifier with cryptographically random entropy. Clock order is a
display convenience, never a correctness or scheduling input.

Explicit IDs MAY be accepted after validation when external coordination guarantees
uniqueness. Scanning for the next `T<n>` MUST NOT be used by parallel-capable commands.
Ticket sync MUST recognize legacy `T<n>` and new `T-<ULID>` forms as local and preserve
the existing provider reassignment protocol.

An ID MUST be unique across active and archived stores. Provider reassignment MUST rename
the shard and rewrite every active edge in one journaled transaction.

## 6. Canonicalization and hashes

Canonical logical JSON sorts object keys recursively, preserves arrays in order,
preserves unknown fields, and has no insignificant whitespace.

Hashes MUST use explicit domain separation. Exact domain strings are frozen in the
implementation and schema tests. Conceptually:

```text
ticketHash = sha256("adlc:ticket:v1\0" + canonical(ticket))
storeHash  = sha256("adlc:active-store:v1\0" + canonical(sorted [id, ticketHash]))
```

Ticket pairs are sorted by a specification-defined, locale-independent ID comparator.
Ticket collection order is non-semantic. Dependency sequencing comes from `edges`; a
future priority field, not filesystem order, may express prioritization.

Physical path, JSON formatting, backend type, store format version, archive content, and
runtime state do not affect logical hashes. Equivalent legacy and directory stores
produce identical hashes, verified by `node --test
packages/tickets/test/hash-equivalence.test.mjs`. Migration succeeds only when every
ticket hash and the store hash match.

**Verify:** `node --test packages/tickets/test/hash-equivalence.test.mjs` runs golden
legacy/directory/archive/formatting vectors and asserts exact equality or inequality as
specified above.

## 7. Validation

One authoritative validator in `@adlc/tickets` MUST cover:

- supported manifest format and version;
- closed filesystem layout and regular-file requirements;
- JSON syntax and ticket schema;
- filename-to-ID equality;
- unique active IDs;
- archive collision checks for creation and full collision checks in archive doctor;
- `scope`, `rails`, and `edges` types;
- every active edge target resolving to an active ticket;
- acyclic active dependency graph; and
- format-specific reserved fields.

Unknown ticket properties remain allowed and preserved. An invalid shard or global
invariant invalidates the entire snapshot. Normal consumers MUST NOT receive a partial
set. A diagnostic loader used only by `doctor` MAY accumulate multiple errors but MUST
not label the store usable.

A newer unsupported store version fails closed with an upgrade instruction. An older
supported version may be read but MUST be explicitly migrated before writes.

## 8. Domain APIs

### 8.1 Immutable snapshot

The public read API returns an immutable snapshot:

```ts
interface TicketSnapshot {
  readonly backend: "legacy" | "directory" | "git-revision";
  readonly formatVersion: number;
  readonly hash: string;
  readonly tickets: readonly ReadonlyTicket[];
  get(id: string): ReadonlyTicket | undefined;
}
```

Nested values MUST be immutable. Development and tests SHOULD deep-freeze them. A
single operation may reuse its loaded snapshot. Security-sensitive decisions MUST load
and validate on-disk state anew in v1; no cross-decision trusted cache is permitted.

### 8.2 Store layer

`TicketStore` owns detection, loading, validation, canonicalization, hashes, locking,
journals, recovery, serialization, and compare-and-swap application. Its writable draft
API is internal to `@adlc/tickets`.

Required backends:

- `LegacyTicketStore` for the 1.x bridge and indefinite migration input;
- `DirectoryTicketStore` for format version 1; and
- read-only `GitTreeTicketStore` for an exact Git revision without checkout or working-
  tree fallback.

### 8.3 Service layer

`TicketService` owns intent and authorization. Public mutations are explicit:

- create and update;
- discard an unprotected draft;
- reassign ID;
- complete;
- archive and restore;
- apply remote reconciliation;
- migrate format; and
- recover or roll back a transaction.

There is no generic public write callback. Protected completion/archive/restore,
identity changes, forced remote resolution, rail narrowing, scope widening, P4 bypass,
and recovery MUST use their dedicated policy and evidence paths.

### 8.4 Compatibility facade

Throughout 1.x, `@adlc/core.loadTickets()` preserves its existing `{ tickets, errors }`
shape and mutable clone behavior. Repository-owned production consumers MUST migrate to
`@adlc/tickets`. A CI boundary test forbids direct production access to store paths
outside the domain package and generated read-only adapters.

## 9. Errors and exit codes

Programmatic results use a discriminated contract:

```ts
type TicketResult<T> =
  | { ok: true; value: T; warnings: TicketWarning[] }
  | {
      ok: false;
      kind: "operational" | "invalid" | "conflict" | "policy";
      code: string;
      message: string;
      details?: unknown;
    };
```

Callers MUST branch on `kind` and stable `code`, never message text. CLI mapping is:

- `0`: success, including advisory warnings;
- `1`: operational filesystem, permission, Git, or dependency error; and
- `2`: invalid contract, stale snapshot, conflict, unresolved recovery, or policy deny.

Unexpected exceptions are contained at the CLI boundary and exit `1`.

## 10. Transactions and concurrency

### 10.1 Worktree boundary

There is one global writer lock per worktree at `.adlc/tickets.lock`. Parallel P4 ticket
development MUST use separate Git worktrees. Per-ticket locks are forbidden in v1
because graph validation, identity, archive, and evidence are global operations.

The lock directory records PID, hostname, start time, command, and transaction ID.
Acquisition uses bounded retries. `doctor` reports stale locks but never removes them.

Remote calls and expensive planning SHOULD occur before locking. After lock acquisition,
the writer reloads and compares `expectedSnapshotHash`. A mismatch aborts the stale plan.
Only deterministic, local, non-sensitive operations may transparently replan; remote or
policy-sensitive operations require renewed review.

### 10.2 Journal protocol

A transaction MUST:

1. acquire the ticket lock;
2. reload and verify the expected snapshot;
3. apply the intent in memory;
4. validate the complete prospective graph;
5. stage every new shard and verified backup outside the tracked store;
6. persist and durability-flush a prepared journal containing operation, before/after
   hashes, paths, and evidence requirements;
7. apply individual no-follow renames/deletions idempotently;
8. verify the complete after snapshot;
9. acquire the manifest lock after the ticket lock when evidence is mandatory;
10. append required evidence;
11. mark complete and remove runtime state; and
12. release locks in reverse order.

Platform-specific durability limits MUST be documented. The protocol is recoverable,
not described as a multi-file atomic commit.

### 10.3 Recovery

After interruption, hashes MUST classify state as complete-before, complete-after, or
partial. Partial state makes normal gates and hooks fail closed.

- Interactive commands explain the operation and offer explicit complete or rollback.
- Non-interactive commands, hooks, and CI perform no recovery writes.
- `adlc ticket store recover --complete` verifies all staged content before applying.
- `--rollback` verifies backups before restoring.
- If neither direction is verifiable, the tool stops for manual intervention.

Recovery, rollback, and bypass events require manifest evidence. Recovery during active
P4 enforcement requires stopping the build context and using the dedicated recovery
path; it is not an implicit hook exemption.

## 11. Policy and evidence

The complete active store and manifest replace `tickets.json` as the trust root inside
an enforced worktree. Runtime files remain writable, but any incomplete transaction or
ambiguous backend blocks security decisions.

Existing protected-base tickets remain canonically immutable in ordinary PRs. New
tickets may be added. Completion, archive, restore, and removal use the protected
administrative path. Storage migration does not weaken this rule.

Evidence records include Git revision, ticket ID when applicable, `ticketHash`,
`storeHash`, and `bindingScope`:

- ticket-scoped gates verify `ticketHash`;
- graph/store-wide gates verify `storeHash`; and
- both hashes remain recorded for forensics.

`.adlc/current-ticket.json` pins `id` and `ticketHash`. An ID mismatch with
`ADLC_TICKET`, an absent ticket, or a changed ticket hash fails closed. Unrelated shard
changes do not stale active-ticket selection.

Mandatory evidence operations are migration, recovery/rollback, ID reassignment,
forced remote reconciliation, rail narrowing, scope widening, protected lifecycle
changes, and P4 bypass. Routine pre-protection authoring relies on Git review.

CI MUST load the trusted base through `GitTreeTicketStore`. The one allowed legacy-base
to-directory-head transition requires canonical equality and the dedicated migration
shape. Missing refs, unreadable trees, malformed base state, or backend ambiguity are
operational failures, never “no rails.”

## 12. Unified CLI

The umbrella surface is:

```text
adlc ticket list
adlc ticket show <id>
adlc ticket create --input <path|->
adlc ticket update <id> --input <path|-> --expect <ticket-hash>
adlc ticket edit <id>
adlc ticket discard <id>
adlc ticket complete <id>
adlc ticket archive <id>
adlc ticket restore <id>

adlc ticket store status
adlc ticket store migrate
adlc ticket store recover
adlc ticket store export

adlc ticket pull
adlc ticket push
adlc ticket sync
adlc ticket doctor
```

The dispatcher routes local/store verbs to `@adlc/tickets` and provider operations to
`@adlc/ticket-sync`. `doctor` composes store checks and configured sync checks while
remaining read-only, offline, and write-free.

Create/update accept full-document JSON from a file or stdin. `edit` uses a temporary
copy and `$EDITOR`, then validates and shows a plan. Inline JSON is not the recommended
interface. All mutations are dry-run by default; `--write` applies. Commands never
stage or commit Git changes.

Dry-run output includes operation, expected/current hashes, field changes, file
operations, graph effects, sensitive-policy flags, evidence requirements, validation,
and after-hash. A stable JSON plan may be applied only when its plan and snapshot hashes
remain current.

There is no general delete. `discard` applies only to unprotected, unreferenced drafts.
Durable tickets are archived.

## 13. Overrides and compatibility

New override forms are `ADLC_TICKET_STORE` and `--ticket-store`. They accept a directory
or, during 1.x, a legacy file. `ADLC_TICKETS` and `--tickets` remain legacy-file aliases
through 1.x. Conflicting forms fail closed. Programmatic APIs SHOULD prefer dependency
injection.

Migration behavior:

- Read-only legacy commands warn without prompting.
- `adlc-init` and interactive writers calculate a migration plan and ask `Apply
  migration? [y/N]`.
- Decline continues against legacy during 1.x.
- `--json` and non-interactive commands never prompt.
- Automation uses `adlc ticket store migrate --write --yes`.
- New repositories always initialize directory format; no `--legacy` initializer exists.

Migration requires a clean worktree and is representation-only. It updates `.gitignore`
to track active/archive directories, stages no Git files, leaves no `.bak`, and verifies
all logical hashes. Git history, explicit legacy export, and transaction rollback are the
backup mechanisms. This repository migrates only in a dedicated follow-up commit after
all consumers support both formats.

Release timeline:

- 1.3.x: full legacy fallback and directory default for new repositories;
- 1.4.x: bridge may continue if required by field evidence; and
- 2.0.0: normal legacy, old environment variable, and old CLI flag support removed;
  migration input retained indefinitely.

## 14. Harness packaging and boundary enforcement

Normal packages import `@adlc/tickets`. Harnesses unable to resolve npm packages consume
a generated self-contained read-only loader from the same canonical source. Generated
loaders expose detection, validation, immutable snapshots, filenames, and hashes only;
they never write.

A generator/drift test and installation smokes MUST prove adapter equivalence. Hand-
maintained inline writable copies are forbidden.

An architectural CI test MUST reject production references that directly access active
store, legacy store, lock, or journal paths outside approved domain/generated modules.

## 15. Platform, performance, and observability

`@adlc/tickets` supports Linux, macOS, and Windows. Full repository CI remains Ubuntu on
Node 18/20/22; focused ticket-domain jobs run on macOS and Windows Node 20. Tests cover
rename, locking, recovery, path/case behavior, line endings, permissions, symlinks where
supported, and interruption.

The practical Git-backend target is 1,000 active tickets; correctness is designed for at
least 10,000 shards. A deterministic 1,000-ticket benchmark establishes release ceilings
from measured CI baselines for cold load, validation, active lookup, single-ticket write,
and rails decisions. Trend reporting is informational in 1.x. Work beyond 1,000 active
tickets is tracked in #168.

There is no phone-home telemetry. `store status --json`, `doctor --json`, migration
summaries, and local benchmark reports provide observability.

## 16. Verification and acceptance criteria

- **AC1 — format:** Golden tests load valid active/archive version-1 stores and reject
  unknown manifests, filename mismatches, extra entries, nested paths, symlinks, case
  collisions, malformed JSON, duplicate IDs, dangling edges, and cycles. **Verify:**
  `node --test packages/tickets/test/directory.test.mjs packages/tickets/test/runtime-layout.test.mjs`.
- **AC2 — equivalence:** Every current real ticket migrates legacy → directory → legacy
  with identical ticket and store hashes and no semantic field/array changes. **Verify:**
  `node --test packages/tickets/test/migrate-real-store.test.mjs`.
- **AC3 — merge benefit:** Git integration tests prove two worktrees adding different
  ULID shards merge without conflict; same-shard edits remain a conflict; post-merge graph
  validation is mandatory. **Verify:** `node --test packages/tickets/test/parallel-merge.test.mjs`.
- **AC4 — transactions:** Fault injection after every durable step proves state is before,
  after, or detectably partial and recoverable, with no lost ticket. **Verify:**
  `node --test packages/tickets/test/fault-injection.test.mjs`.
- **AC5 — concurrency:** Competing writers serialize; stale plans fail compare-and-swap;
  remote/policy-sensitive plans never silently rebase. **Verify:**
  `node --test packages/tickets/test/lock.test.mjs packages/tickets/test/service.test.mjs`.
- **AC6 — archive:** Archive/restore preserve hashes and metadata, reject inbound active
  edges and ID collisions, and keep archives out of active hashes/gates. **Verify:**
  `node --test packages/tickets/test/archive.test.mjs`.
- **AC7 — policy:** Existing protected-base tickets cannot change in ordinary PRs; new
  shards may be added; migration is accepted only under canonical equivalence. **Verify:**
  `node --test scripts/test/rails-guard-ci.test.mjs --test-name-pattern='ticket store'`.
- **AC8 — provenance:** Ticket/store-scoped evidence verifies correct hashes; unrelated
  additions do not stale ticket evidence; active-ticket hash changes deny P4. **Verify:**
  `node --test packages/tickets/test/provenance.test.mjs packages/tickets/test/evidence.test.mjs`.
- **AC9 — compatibility:** All repository-owned consumers use `@adlc/tickets`; the 1.x
  facade and old flags/env retain behavior; conflicting overrides deny. **Verify:**
  `node --test packages/core/test/core.test.mjs packages/tickets/test/store.test.mjs scripts/test/ticket-store-boundary.test.mjs`.
- **AC10 — harnesses:** Every harness install/smoke test passes against directory and
  legacy fixtures, and generated-reader drift is zero. **Verify:**
  `node scripts/ticket-readers/generate.mjs --check && node scripts/codex-install-smoke.mjs . && node scripts/claude-code-plugin-smoke.mjs . && node scripts/opencode-install-smoke.mjs . && node scripts/cursor-install-smoke.mjs . && node scripts/antigravity-install-smoke.mjs .`.
- **AC11 — doctor:** Doctor performs zero writes/network calls and reports all specified
  store, archive, lock, journal, Git tracking, current-ticket, sidecar, and drift checks.
  **Verify:** `node --test packages/tickets/test/doctor.test.mjs packages/ticket-sync/test/doctor.test.mjs`.
- **AC12 — platform:** Ubuntu Node 18/20/22 and focused macOS/Windows Node 20 suites pass.
  **Verify:** the required `ticket-store-platform` workflow matrix is green for the release
  commit and `gh run view --json conclusion,jobs` reports `success` for every matrix job.
- **AC13 — performance:** The measured 1,000-ticket ceilings pass and a benchmark report
  is attached to release evidence. **Verify:**
  `node packages/tickets/scripts/benchmark.mjs --tickets 1000 --assert-ceilings --json` exits 0.
- **AC14 — boundary:** CI finds no unapproved production filesystem bypass. **Verify:**
  `node --test scripts/test/ticket-store-boundary.test.mjs`.
- **AC15 — documentation:** ADR, this spec, implementation plan, migration guide, threat
  model, integration docs, schemas, examples, and 1.3→2.0 timeline are complete.
  **Verify:** `node --test scripts/test/ticket-store-docs.test.mjs`.
- **AC16 — prosecution:** P1 design review and P5 multi-provider adversarial review have no
  unresolved high-severity findings. **Verify:** `adlc gate-manifest show --json` contains
  clear P1 and P5 records bound to the release revision, with at least two distinct P5
  provider families and zero surviving high-severity findings.

Suppressions are denied unless a later ticket explicitly names and justifies one.
