# ADLC Ticket Authoring

Tickets are the executable contract between P2 decomposition, P3 rails, P4 build, and
P5/P6 evidence. Keep them small enough for one fresh agent context.

## Schema fields

- `id`: stable ticket identifier.
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

See `.adlc/tickets.example.json` for a complete fixture.
