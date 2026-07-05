# ticket-prune

**ADLC phase: C12 — maintenance (ticket lifecycle hygiene)**

`.adlc/tickets.json` is a mutable working scratchpad. Nothing else prunes it
after a ticket's work ships, so completed tickets accumulate and masquerade as
an open backlog — you can't tell live work from leftovers without
cross-checking deliverables and merged PRs by hand. `ticket-prune` reports
(and, with `--write`, archives) tickets it can determine are stale.

Addresses [issue #39](https://github.com/voodootikigod/adlc/issues/39).

## Usage

```
ticket-prune [--tickets path] [--archive path] [--base-ref ref] [--write] [--json]
```

Dry-run by default, consistent with every other ADLC writer (`skill-rot`,
`rejection-mining`, `model-ratchet`): it reports what it would archive without
touching `.adlc/tickets.json` until you pass `--write`.

## How "stale" is decided

This was the open question in issue #39: an explicit `status` field on the
ticket vs. inferring from merged deliverables/PRs. Decision, in order:

1. **Prefer an explicit `status` field when present.** The @adlc/core ticket
   schema (`packages/core/lib/tickets.mjs`) doesn't declare a `status` field,
   but `validateTicket()` doesn't reject unknown properties either, so a
   ticket can already carry one. `done` / `closed` / `complete` / `completed`
   / `archived` / `shipped` (case-insensitive) are stale; any other string
   value is treated as an explicit "not done" and wins over the inference
   below even if the ticket's scope looks fully shipped.

2. **Otherwise, infer from scope existing on a base ref.** A ticket with no
   explicit status is stale only if it declares at least one `scope` glob
   *and* every declared glob resolves to at least one file tracked at
   `--base-ref` (default `HEAD`, via `git ls-tree`). A ticket with no declared
   scope is never inferred stale — it's reported active until an explicit
   status settles it.

**Why not "scope/rails + a closing PR reference"?** The issue floated PR
references as a corroborating signal. This repo's ticket schema has no field
that records a PR number, and commit-message conventions aren't reliable
enough to infer one from git history: a `git log --oneline` survey on this
repo shows tickets referenced inconsistently — some commits name the ticket id
directly (e.g. `(T13/T14)`), but the OpenCode `T1`-`T5` tickets' shipping
PRs (#27–#31) reference "Phase A/B/C/E" and never the literal ticket id at
all. Grepping history for ticket ids would therefore *miss* exactly the stale
tickets the issue's own worked example was written to catch. Scope-existence
against a tracked-files snapshot is deterministic, needs no fuzzy text
matching, and is exactly the check the issue's worked example did by hand.

## Flags

| Flag | Description |
|------|-------------|
| `--tickets <path>` | Ticket file to read (default `.adlc/tickets.json`). |
| `--archive <path>` | Archive file to write to under `--write` (default `.adlc/tickets.archive.json`, gitignored — see `.gitignore`'s `.adlc/*` rule). |
| `--base-ref <ref>` | Git ref to check declared `scope` globs against (default `HEAD`). Point at `origin/main` to audit a feature branch's tickets against what's already shipped on trunk. |
| `--write` | Archive stale tickets: move them out of `--tickets` into `--archive` (append/upsert by id — repeated runs accumulate, never clobber). Tickets are archived, never deleted outright. |
| `--json` | Machine-readable `{ baseRef, write, stale[], active[], archived[] }`. |

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Report or archive succeeded — regardless of how many stale tickets were found. This is advisory (like `model-ratchet`), not a pass/fail gate: stale tickets are clutter, not a merge blocker. |
| `1` | Operational error — bad/missing ticket file, invalid JSON, unresolvable `--base-ref`, or the write lock could not be acquired. |

## Examples

```bash
# Report stale tickets on the currently checked-out ref (dry-run, default)
ticket-prune

# Audit tickets against main from a feature branch
ticket-prune --base-ref origin/main --json

# Archive the stale tickets found above
ticket-prune --write
```

## Locking and atomicity

`--write` takes the shared `.adlc/tickets.lock` mkdir-lock before mutating
`tickets.json`, the same lock path `@adlc/ticket-sync`'s writer uses, so the
two writers interoperate instead of racing. Both `tickets.json` and the
archive file are replaced with a tmp-file-then-rename (atomic on POSIX
filesystems).

## Relationship to sibling tools

- **`@adlc/ticket-sync`** — writes/reads `.adlc/tickets.json` from an external
  tracker; shares the same lock path so a sync and a prune never interleave.
- **`model-ratchet` / `skill-rot`** — the other decay-driven, dry-run-by-default
  maintenance checks wired into `/adlc-maintain`; `ticket-prune` follows the
  same reporting contract.

## Core gaps

`packages/core` (frozen — CONVENTIONS rule 2) has no shared writer for
`.adlc/tickets.json`. `lib/store.mjs` re-implements the same mkdir-lock +
tmp-rename protocol `@adlc/ticket-sync`'s `lib/store.mjs` uses (at the same
lock path) rather than inlining a divergent one.
