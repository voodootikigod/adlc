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

## Durability

Sensitive mutations use recoverable, evidence-bearing transactions on both supported
1.x backends. POSIX persistence flushes changed files and parent-directory entries;
Windows flushes files and relies on the documented platform recovery tests because Node
does not provide portable directory fsync.
