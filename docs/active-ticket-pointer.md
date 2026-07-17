# The active-ticket pointer (`.adlc/current-ticket.json`)

This file names the one ticket in flight. Every harness reads it to decide which
ticket governs the current build, so it is a **trust root**: get it wrong and
enforcement silently stops.

It is gitignored runtime state, never tracked. Schema:
[`packages/tickets/schemas/current-ticket.schema.json`](../packages/tickets/schemas/current-ticket.schema.json).
Contract and implementation: `packages/tickets/lib/pointer.mjs`, generated verbatim
into every harness by `scripts/ticket-readers/generate.mjs`.

## The shape

```json
{
  "id": "T-01K0Z8M6D7AF6H2VT3QX91NCE",
  "ticketHash": "4f614498b921eee22bac7c4baf5d251ef019f5179d633fbba8c4d7699c261581"
}
```

Both fields are required. `ticketHash` is the ticket's hash at the moment you
selected it — pinning it is what makes *"the ticket changed after I selected it"*
detectable. Get the current hash from `adlc ticket list --json`.

Prefer writing it through your harness's ADLC ticket command — pi's `adlc-ticket`
handler, for example, writes it atomically and always in canonical form — or set
`ADLC_TICKET=<id>` instead and skip the file entirely.

## One active ticket per worktree

`ADLC_TICKET` and this file must not name different tickets. When they disagree,
every reader **fails closed** — that state is ambiguous, and guessing which ticket
governs the build is exactly the wrong move for a trust root.

The active ticket is per-worktree state. ADLC deliberately does not support two
tickets in flight in one worktree ([spec §2, §10.1](specs/sharded-ticket-store.md)):
there is one writer lock per worktree, and graph validation, identity, archive, and
evidence are all store-global. Parallel work on a second ticket gets its **own
worktree**:

```bash
git worktree add ../repo-T2 -b feat/T2
```

Each worktree has its own pointer and its own lock, so the two never contend. This
is also how `@adlc/fleet` runs tickets in parallel: one worktree per ticket, with
`ADLC_TICKET` injected per worker rather than a shared pointer file.

## How it is read

Two layers, because they know different things. **Identity resolution** needs only the
file and the environment; **store checks** additionally need the ticket store loaded.
Every reader does identity resolution identically. Store checks happen wherever a
snapshot is in hand.

Identity — the same answer in every reader, always:

| Situation | Outcome |
| --- | --- |
| No file and no `ADLC_TICKET` | **Inert** — no active ticket, enforcement no-ops |
| Canonical `{id, ticketHash}` | Resolves |
| `ADLC_TICKET` set, no file | Resolves |
| `ADLC_TICKET` disagrees with the file | **Denies** — `ACTIVE_TICKET_CONFLICT` |
| Unparseable, or an object with no recognized id key | **Denies** — `INVALID_CURRENT_TICKET` |

Store checks — wherever the reader holds a snapshot:

| Situation | Outcome |
| --- | --- |
| Hash does not match the store | **Denies** — `ACTIVE_TICKET_STALE` |
| Ticket not in the store | **Denies** — `ACTIVE_TICKET_MISSING` |
| Pointer pins no `ticketHash` | **Denies** under the strict default; warns under the 1.x bridge |

Where store checks run today: `@adlc/tickets`' own API (strict), `adlc ticket doctor`
(strict), and the Codex rail guard (bridged). The other harness rail checkers and
`@adlc/build-gate`'s adapter resolve identity only — they take no snapshot at that
step — so **they do not detect a stale hash**. They still fail closed on every identity
outcome above, which is what stops the pointer from silently disabling enforcement.
Extending staleness detection to those harnesses is tracked separately; do not read
this page as promising it today.

**To deactivate, delete the file.** Writing `{}` denies; it does not mean "no
ticket". This is deliberate. An object we cannot understand used to read as *"no
active ticket"* and therefore **allow** — a fail-open hole in a trust root, and the
one failure mode a fail-closed system must never have. A pointer whose id key is
misspelled now stops the build instead of quietly disabling the gate.

## Deprecated forms (removed in 2.0)

Because this schema went undocumented for so long, pointers in the wild guessed at
it. Every reader still accepts these so nothing bricks, `adlc ticket doctor` reports
them, and ADLC never writes them:

- `{"ticket": "T1"}` and `{"ticketId": "T1"}` — alias id keys. `ticketId` spread by
  being copied from the gate-manifest's evidence field name.
- `"T1"` — a bare JSON string. Pins no hash.
- Any pointer that omits `ticketHash`. It still resolves under the 1.x bridge, with
  a warning, but staleness cannot be detected. `@adlc/tickets`' own API is strict
  by default and denies it today.

Migrate by rewriting the file as `{"id": "...", "ticketHash": "..."}`, or by
deleting it and re-selecting the ticket.

## Checking it

```bash
adlc ticket doctor --json
```

Doctor parses the pointer, resolves it against the store, verifies the hash, and
reports deprecated aliases — so a stale or malformed pointer surfaces there rather
than as a denied edit mid-build.
