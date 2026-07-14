# `@adlc/tickets`

The canonical ADLC ticket domain. It provides immutable logical snapshots, strict
legacy/directory/Git-revision stores, backend-independent hashes, intent-specific
mutations, recoverable filesystem transactions, migration, archive, and diagnostics.

The package has no runtime dependencies. All writers are dry-run-first through
`adlc ticket`; it never stages or commits Git changes. Existing `.adlc/tickets.json`
repositories remain supported during the 1.x bridge and migrate only with explicit
approval. New stores use one deterministic JSON shard per ticket under
`.adlc/tickets/`.

Sensitive mutations use recoverable, evidence-bearing transactions on both supported
1.x backends. POSIX persistence flushes changed files and parent-directory entries;
Windows flushes files and relies on the documented platform recovery tests because Node
does not provide portable directory fsync.
