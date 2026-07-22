# Sharded ticket-store threat model

The active ticket directory is an executable security contract: its rails, scope,
dependencies, and identity constrain agents and CI. The main assets are protected-base
ticket immutability, complete graph validity, gate provenance, and recoverability without
ticket loss.

Threats and defenses:

- A branch removes rails or rewrites a protected ticket. CI reads the trusted base with
  `GitTreeTicketStore`, compares canonical ticket content, and permits only new tickets
  or an exactly equivalent dedicated migration.
- A malformed, missing, symlinked, nested, case-colliding, or partially written shard
  hides constraints. Closed-layout validation rejects the entire store; no consumer
  receives a partial snapshot.
- Two writers race or apply a stale review. A per-worktree mkdir lock serializes writes,
  and every plan is bound to both its plan hash and expected snapshot hash. Ticket sync
  carries the hash from its pre-network read through commit, so a concurrent edit fails
  with `STALE_SNAPSHOT` instead of being replaced by stale remote state.
- A crash splits a multi-file operation. Staged content, verified backups, a durable
  journal, and final store hashes classify the state. Hooks and CI never auto-recover;
  explicit complete/rollback is required. POSIX writers fsync file contents and affected
  parent directories after creation, rename, and removal. Windows flushes file contents,
  but Node does not expose portable directory-handle fsync; the required Windows CI fault
  suite remains the platform contract rather than a claim of identical POSIX semantics.
- An unrelated ticket addition invalidates active review evidence, or graph drift escapes
  ticket-only evidence. Records carry both `ticketHash` and `storeHash` plus an explicit
  `bindingScope`; each gate verifies the scope it actually depends on.
- A hostile worktree substitutes its own base data. Git-tree reads use argv-only Git
  subprocesses at an exact revision and never fall back to working-tree paths.
- Archive operations create dangling active semantics or conceal replacement IDs.
  Archiving blocks inbound active edges and deterministic-path collisions; restore
  verifies recorded pre-archive hashes and the complete prospective graph. Create,
  provider reconciliation, and ID reassignment also reject IDs already in either archive
  representation.
- Legacy and directory backends coexist to create split-brain state. Detection requires
  exactly one active backend; both-present and incomplete-journal states fail closed.
- A stale or fabricated coldstart cache entry suppresses a real P2 audit. Cache lookups
  (`packages/coldstart/lib/cache.mjs`) bind to `ticketHash` (the same domain-separated hash
  this store computes) AND the resolved model id — a hit requires an exact content+model
  match, so editing a ticket or switching `ADLC_MODEL_CHEAP` is itself sufficient to
  invalidate a stale entry; there is no separate expiry mechanism to bypass for that case.
  Entries deliberately do NOT bind to `storeHash`: a coldstart verdict is a property of one
  ticket's own content, not of the store as a whole, so an unrelated ticket's addition must
  not invalidate an already-computed executability result. Residual risk: an attacker with
  write access to `.adlc/manifest.jsonl` could inject a fabricated PASS entry with a matching
  hash+model to suppress a real gap — this is the same tamper surface every unsigned manifest
  entry carries, closed the same way (HMAC signing via `ADLC_MANIFEST_KEY`), with `--force`
  and `--max-age 0` as an operator escape hatch when a cache entry is suspect.

Residual risks are explicit: same-shard Git conflicts remain real; filesystem writes are
recoverable rather than truly atomic; out-of-band shell mutation is ultimately caught by
the CI diff backstop; and performance above 1,000 active tickets is deferred to #168.

Manifest locks are owner-token bound and are never stolen automatically based on age.
An abandoned `.adlc/manifest.jsonl.lock` therefore fails closed and requires deliberate
operator inspection/removal after confirming the recorded PID/host is no longer active.
