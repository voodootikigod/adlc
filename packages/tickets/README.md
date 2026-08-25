# `@adlc/tickets`

The canonical ADLC ticket domain. It provides immutable logical snapshots, strict
legacy/directory/Git-revision stores, backend-independent hashes, intent-specific
mutations, recoverable filesystem transactions, migration, archive, and diagnostics.

The package has no runtime dependencies. All writers are dry-run-first through
`adlc ticket`; it never stages or commits Git changes. Existing `.adlc/tickets.json`
repositories remain supported during the 1.x bridge and migrate only with explicit
approval. New stores use one deterministic JSON shard per ticket under
`.adlc/tickets/`.

## Discovering the ticket shape

The CLI is self-describing — nothing needs to be inferred by reading an existing
ticket out of the store:

```sh
adlc ticket <command> --help   # flags plus the full input document for that command
adlc ticket create --help      # every field, what reads it, and a runnable example
adlc ticket schema             # the ticket JSON Schema on stdout
```

`create --help` prints a worked example you can pipe straight back in:

```sh
adlc ticket create --input - < ticket.json
```

Both `--help` and `schema` work before a store exists. **Omit `id` on create**:
the service mints a ULID (`T-01K…`) — there is no "next free `T<n>`" to derive.

`lib/help.mjs` holds the one field table the help text and the published
`schemas/ticket.schema.json` are both generated from, and `test/help.test.mjs`
fails if the committed schema drifts from it or if a field the validator polices
goes undocumented.

## Writing to a frozen trust root

Once **any** ticket declares `rails`, the store stops being ordinary data: it is the
configuration deciding what the rail guards freeze, so freezing it too is the only
thing that stops one edit from disabling enforcement. The PreToolUse rail hook has
always denied a structured edit to `.adlc/tickets/**` from that moment on. The store
service now holds the same line for its own writers, so the audit no longer depends
on which door a write came through:

- every `--write` against such a store appends **one** signed `ticket-mutation` entry
  to the gate-manifest, recording the operation, ticket id(s), and the store hash
  either side of the change (`bypass: true`);
- a mutation that already records evidence of its own — rail narrowing, completion,
  reassignment, archive, migration — keeps its existing `ticket-<operation>` entry and
  gains the audit fields. One mutation is never two entries;
- with **no** `ADLC_MANIFEST_KEY` the write refuses *before* touching the store. An
  unsigned entry proves nothing about who made the change, and the manifest is
  append-only, so writing one anyway would be permanent noise. `--allow-unsigned`
  (mirroring `adlc prosecute record-cross-model`) records one deliberately and warns;
- the rule holds on **every** door into the store, not just `adlc ticket`: the legacy
  → sharded migration and its recovery, archive/restore, an interrupted transaction's
  recovery, `ticket-prune`'s direct `tickets.json` write, and the published 1.x
  `LegacyTicketStore.write(tickets)`, which still works but now routes through the
  audited transaction. A contract enforced on one writer and not the others is not a
  contract;
- `ticket-prune` is the one writer that cannot make the store write and the manifest
  append a single act, so it stages, records, then renames. If the rename fails the
  entry is already appended and names a store hash that was never reached — an
  append-only ledger cannot retract that, so prune appends a **correction**
  (`action: 'abandoned'`, before and after hash equal) saying the store did not move.
  If the correction cannot be written either, the failure says so explicitly rather
  than leaving the caller to assume the ledger is true. The correction runs when the
  rename *throws*; a crash or power loss in the same window leaves the false claim
  uncorrected, detectable by comparing the entry's `storeHashAfter` to the store but
  not repaired automatically — this path has no journal and no recovery pass;
- a repo where no ticket declares a rail — in the active set **or the archive** — is
  not a trust root: authoring there needs no key and records nothing. Completing,
  archiving or discarding the last railed ticket does not thaw it, because that
  removal is itself an audited override and the manifest keeps the record after the
  ticket is gone (#162). The one case this cannot see is a repo that removed its last
  rail *before* this change and never had a hook override recorded — nothing on disk
  distinguishes it from a repo that never used rails; see `lib/trust-root.mjs`. That
  set cannot grow, since every removal from this change forward leaves a marker, and
  it shrinks as each such repo takes one audited write. Closing it needs a durable
  adoption record, tracked by ticket `T-01M0TMRSQKGTNWZTFXBPQ2JHNB`.

### Known residuals

Two states this contract does not cover. Both are recorded here so the guarantee is
not read as wider than it is; each is tracked for closure by its own ticket.

- **A crash during `ticket-prune`'s audit-then-rename window.** The compensating entry
  runs when the rename throws; a crash or power loss between the manifest append and
  the rename leaves an entry naming a store hash the store never reached. It stays
  detectable — that hash will not match the store — but this path has no journal and
  no recovery pass, so nothing repairs it automatically. The ordering is deliberate:
  recording after a completed write risks a real mutation with no record at all, which
  is undetectable rather than merely wrong. Tracked by `T-01M0WNX6P09HWKDK429XQ8GGRJ`.
- **A parent-directory swap during `export`.** The destination is validated, then the
  mkdir, temp write and rename address it by path, so a local writer able to rename a
  parent of the destination can redirect the write after the check. Node offers no
  `openat`/`O_NOFOLLOW` for that sequence, so the path cannot be pinned to a directory
  handle. It requires write access to a parent of the operator's chosen destination
  plus winning the race; write access to the repo makes the race unnecessary, and a
  sticky bit blocks it in the usual world-writable case. Tracked by
  `T-01M0WNX6ZA0D94HW2VQKZAPGQ2`.

## Durability

Sensitive mutations use recoverable, evidence-bearing transactions on both supported
1.x backends. POSIX persistence flushes changed files and parent-directory entries;
Windows flushes files and relies on the documented platform recovery tests because Node
does not provide portable directory fsync.
