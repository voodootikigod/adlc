# ADLC Ticket Authoring

Tickets are the executable contract between P2 decomposition, P3 rails, P4 build, and
P5/P6 evidence. Keep them small enough for one fresh agent context.

## Schema fields

- `id`: stable ticket identifier. Purely local tickets use `T<n>`; once synced to an
  external tracker the id becomes the tracker-qualified form (see *Synced ids* below).
- `title`: concise human label.
- `body`: self-contained task text with verification commands and any allowed suppressions.
- `scope`: file globs this ticket may edit.
- `rails`: frozen file globs the builder must not edit during P4.
- `edges`: downstream ticket dependencies with explicit contracts.
- `duration`: rough relative effort for merge forecasting.
- `category`: task type such as `feature`, `bug`, `refactor`, or `docs`.
- `budget`: ADLC tier hint such as `cheap`, `mid`, or `frontier`.

## Rules

- Every acceptance criterion in `body` needs a command, test file, or assertion method.
- Rails must be behavior-bearing files: tests, schemas, contract types, or CI checks.
- Suppressions are denied unless the ticket body declares the exact marker using
  `allow-suppression: <marker>`.
- Edges mean this ticket completes before `edge.to`; each edge must state the contract.

## Synced ids (external trackers)

When a ticket is synced with an external tracker via
[`@adlc/ticket-sync`](./ticket-sync.md), its `id` lives in a **single id space**:

- A purely local ticket is `T<n>` (e.g. `T7`).
- On the first push that **creates** the issue, the id is reassigned to the
  tracker-qualified form — `gh:<owner>/<repo>#<n>` for GitHub (e.g.
  `gh:acme/app#42`). Every `edges[].to` that referenced the old `T<n>` id is
  rewritten store-wide in the same atomic write, so edges never dangle. A
  transferred/renumbered issue runs the same reassignment path.
- Author edges to a not-yet-synced dependency by its local `T<n>` id; it resolves to
  the `gh:` id automatically when that dependency is created. An edge to an id that
  resolves to nothing **fails closed** — it is never silently dropped.

Do not hand-edit a `gh:` id or hand-rename a `T<n>` id that has been synced; let
`push`/`sync` perform the reassignment so the edge rewrite and evidence migration
stay consistent.

## The sync sidecar is not authored

Sync bookkeeping (tracker node ids, the 3-way base hash, create keys) lives in
`.adlc/ticket-sync.state.json` — a **gitignored, rebuildable cache**, never authored
by hand and read by no gate. It is deliberately *not* part of the rails trust root,
so routine syncs leave `tickets.json` byte-identical and never trip the rails-guard.
Only genuine ticket-**content** changes land in `tickets.json` and go through the
normal human + CI review. A missing/tampered sidecar fails safe (at worst it forces a
conflict prompt on the next pull); it can be deleted and rebuilt at any time. See
[docs/ticket-sync.md](./ticket-sync.md) for the full sync model.

See `.adlc/tickets.example.json` for a complete fixture.
