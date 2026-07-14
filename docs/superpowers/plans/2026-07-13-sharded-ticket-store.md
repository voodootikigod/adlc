# Sharded Ticket Store — Implementation and Rollout Plan

> **Status:** Approved design, implementation pending. Execute with TDD, one slice per
> worktree/PR, and the ADLC gates named below. The normative contract is
> [`docs/specs/sharded-ticket-store.md`](../../specs/sharded-ticket-store.md); architectural
> rationale is [ADR-0010](../../adr/0010-sharded-ticket-store.md).

**Goal:** Replace the merge-prone `.adlc/tickets.json` contract with independently
mergeable, immutable ticket shards behind one `@adlc/tickets` domain, without weakening
rails, Git provenance, offline operation, or existing 1.x users.

**Release target:** 1.3.x compatibility bridge; sharded-only normal operation in 2.0.0.

**Tracking epic:** [#179](https://github.com/voodootikigod/adlc/issues/179)

**Risk classification:** Architectural and risk-gated. This changes a schema/migration,
security trust root, deny paths, CI, crash recovery, and agent-constraining behavior. P1,
P3, and P5 require adversarial review; P5 requires at least two distinct provider
families.

## 1. Frozen decisions

Implementation tickets MUST NOT reopen these choices without amending ADR-0010:

- Shards replace the flat file as the single canonical default.
- New stores use `.adlc/tickets/`; existing legacy stores remain fully functional during
  the 1.x bridge and migrate only with approval.
- Migration is clean-worktree, representation-only, dry-run-first, hash-equivalent, and
  never auto-commits.
- `.store.json` is static format/version metadata, never an index.
- Shards are direct ticket objects named `<slug>--<full-id-sha256>.json`.
- Automatic local IDs use `T-<ULID>`; existing IDs remain unchanged.
- `@adlc/tickets` is the sole domain package; store and service are separate layers.
- Read snapshots are immutable and logical ticket order is canonical/non-semantic.
- The complete active directory is the per-worktree trust root.
- Parallel P4 work requires separate Git worktrees.
- One writer lock exists per worktree; stale plans use compare-and-swap protection.
- Multi-file transactions are journaled and recoverable, not called atomic.
- Partial transactions fail closed; recovery requires explicit complete or rollback.
- Protected-base ticket immutability remains unchanged in v1.
- Evidence records both ticket/store hashes and declares its binding scope.
- The archive is tracked, sharded, durable, and outside active snapshots.
- No custom merge driver, trusted cross-decision cache, phone-home telemetry, general
  delete command, or persistent backup file ships in v1.
- Linux/macOS/Windows are supported by the domain package.
- Existing `loadTickets`, env, and flag compatibility lasts through 1.x; normal legacy
  operation ends in 2.0.0 while migration input remains.

## 2. Delivery topology

Use eight independently reviewable slices. Each slice begins only after its dependencies
land on `main`; rebase dependent worktrees after every merge.

```text
S1 domain model + legacy facade
 ├── S2 directory reader + hashes
 │    ├── S3 transaction journal + recovery
 │    │    └── S4 TicketService + unified CLI
 │    │         ├── S5 migration/init/archive
 │    │         └── S7 rails/CI/evidence
 │    └── S6 consumers + generated adapters
 └──────────────────────────────┬─────────────
                                ▼
                     S8 cross-platform/docs/release
                                ▼
                  dedicated repository migration commit
```

S6 may begin after S2 and use read-only APIs while S3/S4 finish. S5 depends on S3/S4.
S7 depends on S2, S4, and enough of S6 to exercise real harnesses. S8 integrates all.

## 3. Slice 1 — Domain model, immutable snapshots, legacy compatibility ([#175](https://github.com/voodootikigod/adlc/issues/175))

**Package:** new `packages/tickets/` (`@adlc/tickets`, zero dependencies).

**Primary files:**

```text
packages/tickets/package.json
packages/tickets/index.mjs
packages/tickets/index.d.ts
packages/tickets/lib/{errors,canonical,ids,filename,schema,snapshot}.mjs
packages/tickets/lib/stores/legacy.mjs
packages/tickets/schemas/*.schema.json
packages/tickets/test/*.test.mjs
packages/core/lib/tickets.mjs
packages/core/index.{mjs,d.ts}
```

### Red tests first

- Canonical object keys are order-insensitive; arrays remain order-sensitive.
- Ticket and store hash domain separation is frozen by golden vectors.
- Equivalent legacy envelopes return canonical ID ordering and identical hashes.
- Snapshots and nested values cannot be mutated in development/tests.
- Unknown fields round-trip losslessly.
- Duplicate IDs, dangling edges, cycles, invalid types, and malformed JSON invalidate the
  entire legacy snapshot.
- `T-<ULID>` generation is format-valid and collision-resistant under parallel-process
  sampling; existing IDs remain accepted.
- Full SHA-256 filenames are deterministic across Unicode IDs and do not depend on locale.
- Structured errors map to stable codes and exit categories.
- `@adlc/core.loadTickets()` preserves its existing result shape and mutable clone
  behavior.

### Build

1. Move the canonical logical ticket validator and DAG primitives into `@adlc/tickets`.
2. Implement immutable `TicketSnapshot`, canonical ID comparator, hashes, ID generation,
   and filename derivation.
3. Implement `LegacyTicketStore` as read/write compatibility for later service use.
4. Make `@adlc/core/tickets` a deprecated delegating facade without changing 1.x callers.
5. Generate and commit JSON Schemas from one in-code definition; add schema drift tests.

### Verify

```bash
node --test packages/tickets/test/
node --test packages/core/test/
npm test
```

**Exit gate:** no repository consumer has changed behavior; new APIs are additive.

## 4. Slice 2 — Directory store, closed layout, Git-revision reader ([#173](https://github.com/voodootikigod/adlc/issues/173))

**Depends on:** S1.

**Primary files:**

```text
packages/tickets/lib/stores/directory.mjs
packages/tickets/lib/stores/git-tree.mjs
packages/tickets/lib/layout.mjs
packages/tickets/test/{directory,filesystem,git-tree,merge}.test.mjs
```

### Red tests first

- Valid active/archive manifests and direct shard objects load.
- Extra files, nested directories, symlinked directory/shards, non-regular objects,
  filename mismatches, Unicode/case collisions, unsupported versions, and partial graphs
  fail closed.
- Directory and legacy fixtures produce identical logical hashes.
- Ticket discovery order cannot affect output or hashes.
- `GitTreeTicketStore` reads an exact ref, distinguishes absent paths from Git failure,
  handles legacy and directory trees, and never falls back to the worktree.
- Two worktrees adding different ULID shards merge cleanly; same-shard edits conflict;
  a clean textual merge that creates a dangling edge is rejected by validation.

### Build

1. Implement strict no-follow layout inspection and complete snapshot validation.
2. Implement active and archive manifests with independent format identifiers.
3. Implement backend detection that allows exactly one authoritative store.
4. Implement read-only Git-tree loading using argv-only Git subprocess calls.
5. Add 1,000/5,000/10,000 fixture generation for benchmarks; only 1,000 is a release
   ceiling in v1.

### Verify

```bash
node --test packages/tickets/test/directory.test.mjs
node --test packages/tickets/test/filesystem.test.mjs
node --test packages/tickets/test/git-tree.test.mjs
node --test packages/tickets/test/merge.test.mjs
```

**Exit gate:** directory reads are security-equivalent to legacy reads; no writer exists
yet.

## 5. Slice 3 — Locking, journaled transactions, recovery ([#172](https://github.com/voodootikigod/adlc/issues/172))

**Depends on:** S2.

**Primary files:**

```text
packages/tickets/lib/{lock,journal,transaction,recovery,durability}.mjs
packages/tickets/test/{lock,transaction,recovery,fault-injection}.test.mjs
packages/tickets/test/fixtures/fault-worker.mjs
```

### Red tests first

- One per-worktree mkdir lock serializes competing child processes.
- Lock metadata is complete; bounded timeout is deterministic; stale locks are reported
  but never silently removed.
- Expected snapshot mismatch aborts before any tracked write.
- Fault injection after every durable step leaves complete-before, complete-after, or
  detectably partial state.
- Complete and rollback recovery are idempotent and refuse corrupt/missing staged data.
- Readers deny partial journal state.
- Lock acquisition order is tickets then manifest; reverse order is rejected in tests.
- A failed archive write never loses the active ticket; duplicate-before-removal is the
  only tolerated intermediate recovery shape.
- SIGINT/SIGTERM cleanup is best effort; SIGKILL recovery relies only on durable journal
  state.

### Build

1. Preserve `.adlc/tickets.lock` for interoperability during 1.x.
2. Define a versioned journal schema with operation, actor/context, before/after hashes,
   file operations, backup/stage hashes, evidence requirement, and state.
3. Stage outside tracked directories; flush files and directories where supported.
4. Apply no-follow file operations idempotently and verify the final logical snapshot.
5. Implement diagnostic classification and explicit complete/rollback recovery.
6. Expose no generic public write API.

### Verify

```bash
node --test packages/tickets/test/lock.test.mjs
node --test packages/tickets/test/transaction.test.mjs
node --test packages/tickets/test/recovery.test.mjs
node --test packages/tickets/test/fault-injection.test.mjs
```

**Exit gate:** every injected interruption proves no ticket loss and a deterministic
recovery outcome.

## 6. Slice 4 — TicketService policy and unified CLI ([#174](https://github.com/voodootikigod/adlc/issues/174))

**Depends on:** S3.

**Primary files:**

```text
packages/tickets/lib/service/*.mjs
packages/tickets/bin/adlc-tickets.mjs
packages/tickets/test/{service,plans,cli,policy}.test.mjs
packages/cli/lib/{registry,dispatch}.mjs
packages/ticket-sync/bin/ticket-sync.mjs
```

### Red tests first

- Create/update/discard/reassign/complete/archive/restore/reconcile operations enforce
  their distinct policies.
- Full-document file/stdin input cannot be confused with inline shell syntax.
- Dry-run writes nothing and emits stable human/JSON plans.
- Applying a plan requires matching snapshot and plan hashes.
- Rail narrowing, scope widening, identity changes, protected lifecycle changes, forced
  reconciliation, recovery, and P4 bypass require explicit authorization/evidence.
- Discard refuses protected or referenced tickets.
- Commands never stage or commit Git changes.
- CLI maps structured error kinds to 0/1/2 without message parsing.
- Existing `adlc ticket pull|push|sync|doctor` routing remains compatible.

### Build

1. Implement intent-specific services; keep transaction draft internal.
2. Implement stable mutation plan and JSON schemas.
3. Add `list`, `show`, `create`, `update`, `edit`, `discard`, `complete`, `archive`, and
   `restore` local verbs.
4. Add nested `ticket store` dispatch and preserve provider sync verbs.
5. Compose `doctor` from offline store checks plus configured sync checks.
6. Add `ADLC_TICKET_STORE`/`--ticket-store` and 1.x conflict-aware aliases.

### Verify

```bash
node --test packages/tickets/test/service.test.mjs
node --test packages/tickets/test/plans.test.mjs
node --test packages/tickets/test/cli.test.mjs
node --test packages/cli/test/
node --test packages/ticket-sync/test/
```

**Exit gate:** all official mutations route through TicketService and remain dry-run by
default.

## 7. Slice 5 — Migration, init, tracked archive, sync/prune integration ([#171](https://github.com/voodootikigod/adlc/issues/171))

**Depends on:** S4.

**Primary files:**

```text
packages/tickets/lib/{migrate,archive,export,doctor}.mjs
packages/tickets/test/{migrate,archive,doctor,prompt}.test.mjs
packages/ticket-sync/lib/{store,pull,push,doctor}.mjs
packages/ticket-prune/lib/{run,store}.mjs
plugins/*/commands-or-scaffold init files
packages/core/lib/scaffold-hygiene.mjs
```

### Red tests first

- This repository's real legacy fixture migrates to shards and exports back with
  identical per-ticket/store hashes and preserved arrays/unknown fields.
- Invalid source content blocks migration without tracked writes.
- Clean-worktree enforcement rejects mixed implementation/migration changes.
- Interactive prompt defaults to no; decline continues a fully writable legacy command
  in 1.x; JSON/non-TTY never prompt.
- `--write --yes` is deterministic and leaves no backup file.
- Both backends present fail closed; recoverable migration remnants are classified via
  journal only.
- New init creates only directory/archive manifests and correct `.gitignore` negations.
- Archive blocks inbound active references and collisions; restore verifies metadata and
  graph validity.
- Sync ID reassignment renames the shard and rewrites edges in one transaction while the
  sidecar remains outside the trust root.
- Legacy archive import preserves old metadata.

### Build

1. Implement status, migration, export, archive/restore, and read-only doctor.
2. Add prompt policy exactly as specified; do not add a tracked defer flag.
3. Update init/scaffold hygiene and all harness init commands from file to directory.
4. Port sync and prune writers to TicketService; delete their duplicated lock/store
   implementations only after contract tests pass.
5. Keep sync sidecar behavior and idempotent remote-create recovery provider-owned.
6. Document the dedicated migration commit and long-lived-branch rebase barrier.

### Verify

```bash
node --test packages/tickets/test/migrate.test.mjs
node --test packages/tickets/test/archive.test.mjs
node --test packages/tickets/test/doctor.test.mjs
node --test packages/ticket-sync/test/
node --test packages/ticket-prune/test/
```

**Exit gate:** a real-store migration and rollback rehearsal is green, and legacy users
can still decline without losing function.

## 8. Slice 6 — Consumer migration and generated harness readers ([#176](https://github.com/voodootikigod/adlc/issues/176))

**Depends on:** S2 for reads; merge after S4/S5 where writers are affected.

**Primary scope:** every current production reference to `.adlc/tickets.json` across
packages, plugins, scripts, CI helpers, generated routers/commands, and docs.

### Red tests first

- An architectural scanner fails on new direct production reads/writes, lock access, or
  journal access outside approved modules.
- Generated loader output is byte-stable and drift detection catches hand edits.
- Generated readers match canonical legacy/directory validation and hash golden vectors.
- Each harness install smoke runs against both store fixtures.
- Long-lived hooks reload on every security-sensitive decision and detect shell/out-of-
  band shard changes.

### Build

1. Migrate coldstart, model-router, merge-forecast, rails/build gates, runner,
   prosecution, prune, sync, and scripts to injected snapshots/services.
2. Create a canonical generator for constrained read-only ESM/CJS bundles.
3. Replace hand-maintained inline readers; never generate writers.
4. Add the boundary allowlist and make violations a required CI failure.
5. Update `ADLC_TICKETS` and path-specific tests to new injection APIs while retaining
   compatibility cases.

### Verify

```bash
rg -n --hidden --glob '!node_modules' --glob '!.git' '.adlc/tickets.json' packages plugins scripts
node scripts/ticket-readers/gen.mjs --check
node scripts/codex-install-smoke.mjs .
node scripts/claude-code-plugin-smoke.mjs .
node scripts/opencode-install-smoke.mjs .
node scripts/cursor-install-smoke.mjs .
node scripts/antigravity-install-smoke.mjs .
npm test
```

The `rg` output must contain only approved compatibility, migration, fixture, and
documentation references.

**Exit gate:** no production bypass remains and every harness reads both backends.

## 9. Slice 7 — Rails CI, dual-hash evidence, active-ticket pinning ([#178](https://github.com/voodootikigod/adlc/issues/178))

**Depends on:** S2, S4, and relevant S6 readers.

**Primary files:**

```text
scripts/rails-guard-ci.mjs
scripts/test/rails-guard-ci.test.mjs
packages/rails-guard/**
packages/runner/**
packages/gate-manifest/**
plugins/* rails/build-gate adapters and tests
docs/ci/rails-guard.yml
```

### Red tests first

- CI loads exact trusted base snapshots through Git-tree reader for all base/head
  combinations: legacy/legacy, directory/directory, allowed equivalent
  legacy/directory migration, malformed, missing, and ambiguous.
- Existing base tickets remain canonically unchanged in ordinary PRs; new shards are
  allowed; malicious delete/rename/rail strip/scope widen fails.
- Migration is accepted only when logical hashes match and diff shape is migration-only.
- Ticket-scoped evidence survives an unrelated shard addition but fails active ticket
  mutation.
- Store-scoped evidence fails any active store mutation.
- `current-ticket.json` pins ID/hash and denies stale, missing, or conflicting selection.
- Full-store freeze applies within one enforced worktree; separate worktrees can build.
- Incomplete journals and ambiguous stores deny every security decision.
- Shell mutation remains caught by the CI diff backstop.

### Build

1. Replace base `git show tickets.json` logic with Git-tree snapshots.
2. Preserve protected-base immutability and completed-rail lifecycle semantics.
3. Version evidence schemas with `ticketHash`, `storeHash`, and `bindingScope`.
4. Update runner assertion and acceptance revision binding.
5. Update every harness active-ticket cache key and rails trust-root path.
6. Add preflight denial for multi-ticket P4 execution in one worktree.
7. Update CI templates and bootstrap ceremonies for the directory trust root.

### Verify

```bash
node --test scripts/test/rails-guard-ci.test.mjs
node --test packages/rails-guard/test/
node --test packages/runner/test/
node --test packages/gate-manifest/test/
node --test plugins/adlc-claude-code/hooks/test/
node --test plugins/adlc-opencode/test/
node --test plugins/adlc-cursor/test/
node --test plugins/adlc-pi/test/
```

**P3 gate:** adversarially review the new path/identity/hash rail set and generated
adapter boundary before any builder receives it.

**Exit gate:** sharding is at least as strict as the flat trust root and parallel
ticket evidence remains usable.

## 10. Slice 8 — Cross-platform, documentation, release bridge ([#177](https://github.com/voodootikigod/adlc/issues/177))

**Depends on:** S1–S7.

### Red tests and CI first

- Add focused `@adlc/tickets` workflow jobs on macOS and Windows Node 20.
- Retain full Ubuntu Node 18/20/22 repository matrix.
- Run lock, path, case, rename, read-only, line-ending, journal, and recovery tests on
  each supported platform, with explicit capability skips only.
- Generate 1,000-ticket benchmarks and set a loose measured regression ceiling.
- Exercise package tarball/install behavior so generated readers and schemas ship.

### Documentation

Update or add:

- ADR-0010 and the normative spec;
- `docs/ticket-authoring.md` and `docs/ticket-sync.md`;
- a dedicated migration and rollback guide;
- a threat model;
- package reference and toolkit pages;
- all integration, init, command, and generated router content;
- JSON Schemas and complete examples;
- changelog/release notes with 1.3.x, possible 1.4.x, and 2.0.0 dates/policy; and
- local observability (`store status`, doctor, benchmarks) with no telemetry.

### Release rehearsal

1. Pack/install every affected package into a temporary clean environment.
2. Initialize a new directory-store repository and run P0–P6 smoke paths.
3. Clone a legacy fixture, decline migration, and prove full 1.x operation.
4. Migrate the legacy fixture interactively and non-interactively.
5. Inject and recover a partial transaction.
6. Export legacy and verify hashes.
7. Run all harness smokes and rails CI against the migrated fixture.
8. Attach the 1,000-ticket benchmark report.

### Verify

```bash
npm test
node scripts/router/gen-routers.mjs --check
node scripts/ticket-readers/gen.mjs --check
adlc spec-lint docs/specs/sharded-ticket-store.md
```

Run P5 with at least two distinct provider families and resolve every high-severity
finding. Require two consecutive dry verified passes per the repository prosecution
policy.

**Exit gate:** every normative acceptance criterion is linked to green evidence and the
release notes make the compatibility/removal timeline unambiguous.

## 11. Dedicated repository migration commit

This is not part of S1–S8 implementation diffs.

### Preconditions

- 1.3.x-compatible code is merged and installed.
- All production consumers pass the architecture boundary test.
- No ticket-writing branches are in flight; remaining worktrees are rebased or paused.
- Working tree is clean and `main` is current.
- Legacy and directory migration rehearsal is green on the exact current file.

### Procedure

```bash
adlc ticket doctor --json
adlc ticket store migrate
adlc ticket store migrate --write --yes
adlc ticket doctor --archive --json
git diff -- .adlc .gitignore
```

Confirm:

- deletion of only `.adlc/tickets.json` from the old active contract;
- addition of active/archive manifests and deterministic shards;
- required `.gitignore` negations;
- identical before/after ticket and store hashes;
- no semantic ticket diff;
- no runtime journals/backups tracked; and
- no unrelated code changes.

Create one human-reviewed migration-only Git commit. Run the complete release gate and
rails CI. If rejected before merge, use transaction rollback or reset only the dedicated
commit through normal non-destructive Git workflow. After merge, rollback is an explicit
Git revert plus compatible legacy export only if the release itself is being rolled back.

## 12. Release gate checklist

- [x] Legacy and directory backend contracts green.
- [x] Exhaustive transaction fault injection and recovery green.
- [x] Real repository migration/export equivalence green.
- [x] Rails base/head/migration/hostile matrix green.
- [x] Dual-hash evidence and active-ticket pinning green.
- [x] Parallel-worktree and post-merge semantic validation green.
- [x] Every harness smoke and generated-reader drift check green.
- [x] No unapproved direct production access to store paths.
- [ ] Ubuntu 18/20/22 and focused macOS/Windows 20 CI green.
- [x] Measured 1,000-ticket ceiling green with report.
- [x] ADR, spec, migration guide, threat model, schemas, examples, and timeline complete.
- [x] P1 design prosecution clear.
- [ ] P3 rail-set adequacy prosecution clear.
- [ ] P5 multi-provider prosecution clear with no unresolved high findings.
- [x] Dry-run migration and rollback rehearsal clear.
- [ ] P6 human acceptance of CLI plans, Git diffs, recovery UX, and migration evidence.

## 13. Premortem

| Failure | Defense | Proof |
|---|---|---|
| New shared index recreates conflicts | Static manifest only; boundary tests | Two-worktree merge test |
| Sequential IDs collide across worktrees | ULID automatic IDs | Parallel creation test |
| One malformed shard silently drops rails | Whole-store fail closed | Hostile layout/JSON matrix |
| Partial multi-file write loses a ticket | Staging, backups, journal, hashes | Step-boundary fault injection |
| Recovery mutates in CI/hooks | Explicit interactive/flag-only recovery | Non-TTY zero-write tests |
| Store changes after plan review | Expected snapshot + plan hash | CAS/stale plan tests |
| Whole-store evidence breaks parallelism | Scoped dual hashes | Unrelated-addition evidence test |
| Ticket-only evidence misses graph drift | Store binding for graph-wide gates | Binding-scope schema tests |
| Migration changes ticket semantics | Per-ticket/store hash equivalence | Real round-trip fixture |
| Base rails are read from hostile HEAD | Git-tree trusted base reader | Base/head attack tests |
| Inline harness readers drift | Generated read-only bundles | Generator drift + install smokes |
| Direct path access returns over time | CI architecture boundary | Planted bypass test |
| Archive creates dangling semantics | Block inbound active edges | Archive graph tests |
| Cache hides shell tampering | Reload every security decision | Out-of-band mutation tests |
| Windows rename/case differs | Focused platform CI | Windows fault/path suite |
| Legacy support becomes permanent | Documented 2.0 removal gate | Release checklist/changelog |

## 14. Deferred follow-ups

- [#167](https://github.com/voodootikigod/adlc/issues/167): explicit security-aware
  `adlc ticket merge` assistant if same-shard conflict evidence justifies it.
- [#168](https://github.com/voodootikigod/adlc/issues/168): performance/backend work
  beyond 1,000 active tickets, including safe caches and optional Dolt evaluation.
- A monotonic protected-ticket update policy, if desired, requires its own security ADR;
  storage v1 preserves current immutability.
- A production Dolt backend requires Git↔Dolt revision binding, offline worktree behavior,
  trust-root availability, migration, and rollback design before implementation.
