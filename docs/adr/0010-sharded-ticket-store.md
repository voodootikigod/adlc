# ADR 0010: Sharded, Git-native ticket storage behind a domain boundary

**Status:** Accepted

**Date:** 2026-07-13

**Decider:** Chris Williams

**Related:** [Ticket authoring](../ticket-authoring.md),
[ticket sync](../ticket-sync.md), [ADR-0008](./0008-adversarial-review-coverage-map.md),
[implementation epic #179](https://github.com/voodootikigod/adlc/issues/179),
[scalability follow-up #168](https://github.com/voodootikigod/adlc/issues/168), and
[merge-assistant follow-up #167](https://github.com/voodootikigod/adlc/issues/167).

## Context

ADLC currently stores every executable ticket contract in one tracked file,
`.adlc/tickets.json`. The file is simultaneously:

- the P0 authoring surface;
- the P2 dependency graph and model-routing input;
- the P3/P4 rails trust root;
- the input to build, prosecution, and acceptance gates;
- the local half of GitHub Issues synchronization; and
- a frequently edited Git artifact.

In this repository it has grown to roughly 151 KB and 41 tickets. About 154 files refer
to the concrete `tickets.json` path, and the file has accumulated a lock protocol,
atomic replacement, a sync sidecar, three-way reconciliation, validation, pruning,
and CI trust-root defenses. It is functioning as a database without a database
boundary.

The single array is a merge hotspot. Two branches adding unrelated tickets can edit the
same array tail, and whole-file serialization makes logically independent work look
physically related to Git. The coupling is especially expensive in ADLC because ticket
fan-out is intentionally worktree-based and ticket contracts are expected to merge back
with their code.

Dolt was evaluated as a replacement. Its primary-keyed rows, SQL constraints,
cell-level merges, and versioned history fit the logical data well. It was rejected as
the default because it would create a second version-control plane beside Git. ADLC
would then need to bind every Git revision to a Dolt revision, coordinate two branch and
review systems, preserve offline hooks, and make rails CI fetch an external trust root.
That trade becomes attractive only for substantially larger or centrally coordinated
ticket graphs.

## Decision

### 1. Replace the flat file with tracked ticket shards

The canonical Git-native layout is:

```text
.adlc/
  tickets/
    .store.json
    <slug>--<full-id-sha256>.json
  ticket-archive/
    .store.json
    <slug>--<full-id-sha256>.json
```

Each active shard contains one ticket object directly. `.store.json` contains only a
format identifier and version; it is never an index. The archive is tracked and durable
but excluded from normal active snapshots and gates.

The path is derived from a readable, bounded ASCII slug plus the full SHA-256 of the
exact UTF-8 ticket ID. The ticket ID inside the JSON remains authoritative. The store
rejects filename mismatches, unexpected files, nested directories, symlinks, and other
non-regular objects.

### 2. Introduce one ticket domain package

A new zero-dependency `@adlc/tickets` package owns:

- the canonical ticket model and schema;
- immutable ticket snapshots;
- legacy, directory, and read-only Git-revision stores;
- canonical ticket and store hashes;
- locking, journals, recovery, and migration;
- the policy-bearing `TicketService`; and
- the local portion of the unified `adlc ticket` command surface.

Persistence and workflow policy are separate layers. `TicketStore` guarantees safe
loading, structural validity, durability, and optimistic concurrency. `TicketService`
exposes intent-specific operations and enforces rails, scope, identity, archive,
protected-base, and evidence policy. The raw writable store remains internal.

`@adlc/core.loadTickets()` remains a compatibility facade throughout 1.x. Repository
code moves to `@adlc/tickets`; an architectural CI test prohibits new direct production
reads or writes of ticket paths.

### 3. Keep Git as the coordination and review system

Parallel P4 builds require isolated Git worktrees. The complete active store is frozen
inside each enforced worktree. Different worktrees may add or modify different shards,
which Git merges independently. Parallel ticket writes in one worktree are unsupported.

No custom Git merge driver is installed in v1. A same-shard collision remains a real
Git conflict. A future explicit, dry-run-first merge assistant is tracked in #167.

### 4. Preserve and strengthen the trust model

The entire active directory, including `.store.json`, replaces `tickets.json` as the
P3/P4 trust root. Existing protected-base ticket contracts remain immutable to ordinary
PRs. New tickets may be introduced; completion, archive, restoration, and other
protected changes use the existing administrative ceremony.

Evidence records carry:

- the Git revision;
- the active ticket ID and canonical `ticketHash`;
- the complete active `storeHash`; and
- an explicit binding scope of `ticket` or `store`.

Ticket-scoped evidence is not invalidated by unrelated shard additions. Graph-wide
evidence is bound to the complete store. Active-ticket state pins both ID and ticket
hash.

### 5. Use recoverable filesystem transactions

The directory store uses one writer lock per worktree, optimistic snapshot comparison,
a write-ahead journal, staged new files, verified backups, and final hash verification.
A multi-file filesystem write is described as recoverable, not falsely claimed to be
atomic.

After a crash the store must be entirely before, entirely after, or detectably partial.
Partial state fails closed. Interactive recovery requires an explicit complete-or-
rollback choice; hooks, CI, and non-interactive commands never mutate recovery state.

The canonical lock order for audited writes is tickets lock, then manifest lock.

### 6. Make migration explicit but friendly

New repositories use shards immediately. Existing repositories in 1.x may remain fully
functional on the legacy backend.

Read-only commands warn but do not interrupt. `adlc-init` and interactive ticket writers
offer a validated migration plan and ask `Apply migration? [y/N]`. Non-interactive and
JSON modes never prompt. Explicit automation uses `adlc ticket store migrate --write
--yes`.

Migration is representation-only: canonical ticket and store hashes must remain equal.
It requires a clean worktree, runs as a dedicated transition, leaves no persistent
backup file, and never stages or commits automatically. This repository migrates in a
separate commit after all consumers support both backends.

### 7. Use a time-bounded compatibility bridge

- **1.3.x:** directory storage ships; new repositories default to it; existing legacy
  stores may decline migration and remain readable and writable.
- **1.4.x:** the bridge may continue if field experience requires it.
- **2.0.0:** normal legacy operation, `ADLC_TICKETS`, and `--tickets` are removed.
  The legacy migration reader remains available indefinitely.

`ADLC_TICKET_STORE` and `--ticket-store` are the new overrides. Conflicting old and new
overrides fail closed.

### 8. Use collision-resistant IDs for new local tickets

Automatic `max(T<n>) + 1` allocation is unsafe across worktrees. Newly generated local
IDs use `T-<ULID>`. Existing and explicitly coordinated IDs remain valid and unchanged.
Ticket sync treats legacy and ULID ticket IDs as local until provider reassignment.

## Consequences

### Positive

- Independent ticket changes merge as independent Git paths.
- Git continues to review code and its ticket contract in one commit graph.
- One domain boundary replaces path knowledge scattered across the repository.
- The same logical API can support a future Dolt backend.
- Immutable snapshots, logical hashes, and typed mutations improve provenance.
- Tracked immutable archive shards remove completed tickets from the active graph
  without discarding their history on fresh clones.
- Journaled recovery makes multi-ticket operations honest and testable.

### Costs

- A one-ticket update now involves directory discovery and global graph validation.
- Multi-ticket writes need a journal and recovery protocol.
- Every harness and CI path must migrate from direct flat-file assumptions.
- Cross-platform filesystem behavior becomes part of the supported contract.
- Migration requires a coordinated, dedicated commit before further fan-out.
- A branch that missed the migration barrier must rebase before continuing ticket
  writes.

### Residual risks

- Same-ticket edits still conflict; this is intentional and tracked separately.
- Out-of-band shell writes can race an in-session check; CI remains the unbypassable
  diff backstop.
- Full validation on every security decision may become expensive above 1,000 active
  tickets; #168 owns evidence-driven optimization.
- The filesystem cannot provide a true multi-file atomic commit. Fail-closed journals
  and explicit recovery are the mitigation.
- The archive is outside the active trust root. It is durable in Git, but normal gates
  deliberately do not trust or scan its entire contents.

## Rejected alternatives

### Keep one flat JSON file and improve locking

Locking solves simultaneous local writers, not Git branch merge conflicts. The existing
implementation already uses locking and atomic replacement.

### JSON Lines

JSONL keeps every ticket in one path and retains array-tail/addition conflicts. It also
makes large ticket bodies and per-record editing less pleasant.

### One provider-specific directory hierarchy

The core accepts arbitrary IDs and already contains nonstandard local IDs. Encoding
provider semantics into paths would make every new provider a storage-format change.

### Tracked manifest index

An ID list, count, ordering, or hash index would change on routine ticket updates and
recreate the shared merge hotspot. Ticket discovery scans the directory.

### Permanent selectable legacy and directory backends

Permanent coexistence doubles the security and test matrix and invites split-brain
state. Legacy support is a migration bridge only.

### Commit Dolt storage inside Git

Binary database storage is not a useful Git diff or merge surface and would defeat
Dolt's own version-control model.

### Make Dolt the default remote trust root

This solves data merging but introduces dual revision coordination, remote availability,
authentication, and two review systems. It remains a possible future backend behind the
domain boundary.

### Install a custom Git merge driver

Implicitly merging rails, scope, identities, dependencies, and unknown fields is too
risky for the first release. Explicit assistance can be added after observed need.

## Revisit triggers

Revisit this ADR if:

- real repositories exceed the 1,000-active-ticket operating target;
- full validation violates measured hook or CI budgets;
- same-shard conflict reports justify #167;
- a cross-repository centralized ticket graph becomes a primary product requirement;
- Windows or network-filesystem durability cannot meet the specified recovery contract;
  or
- the protected-base authorization model changes independently of storage.
