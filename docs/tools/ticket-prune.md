---
title: ticket-prune
description: Documentation for the ticket-prune tool in the ADLC toolkit.
---

# ticket-prune

**ADLC phase: C12 — maintenance (ticket lifecycle hygiene)**

The active ADLC ticket store is a mutable working set. Nothing else prunes it
after a ticket's work ships, so completed tickets accumulate and masquerade as
an open backlog — you can't tell live work from leftovers without
cross-checking deliverables and merged PRs by hand. `ticket-prune` reports
(and, with `--write`, tombstones) tickets it can determine are stale.

Addresses [issue #39](https://github.com/voodootikigod/adlc/issues/39).

## Usage

```
ticket-prune [--tickets path] [--base-ref ref] [--write] [--ceremony] [--json]
```

Dry-run by default, consistent with every other ADLC writer (`skill-rot`,
`rejection-mining`, `model-ratchet`): it reports what it would prune without
mutating the store until you pass `--write`. On a canonical sharded store,
`--write` archives stale tickets through the active→archive transaction; on a
legacy `.adlc/tickets.json` store it tombstones them in place, as described next.

## Tombstoning (legacy store), not removal (#104)

On a legacy `.adlc/tickets.json` store, `--write` does **not** delete a stale
ticket or move it to a side file. It adds `completed: true` to the ticket **in
place** and changes nothing else. This is deliberate: `.adlc/tickets.json` is the
rails-guard trust root, and its CI gate (`scripts/rails-guard-ci.mjs`) hard-denies
any PR that *removes* or otherwise mutates a base ticket. The one exception the
gate carves out is adding exactly `completed: true` to a ticket that declares
**no rails** — that annotation grants zero unfreeze privilege, so it is safe in an
ordinary PR. Tombstoning is built to produce precisely that diff, so a routine
prune merges without an admin override.

A stale ticket that **still freezes rails** is *not* auto-tombstoned by `--write`:
completing it would expire its rails from the union (a privileged unfreeze), which
the gate reserves for the protected-base admin ceremony. Those tickets are
reported — **in dry-run as well as write** (#198) — under `needsCeremony` with
`blocker: "rails-freeze"`, so the drift is visible before it blocks a PR rather
than only when you try to write.

## The rail-cleanup ceremony (`--ceremony`, admin-only) (#198)

`--ceremony` is the protected-base admin action that completes the
`needsCeremony` rail-freezing tickets — the one completion an ordinary PR cannot
make. It adds `completed: true` to each in place (the same add-only edit as a
tombstone; reported under `ceremonyCompleted`), expiring their rails per T36. It
**refuses to write and returns an operational error unless `ADLC_RAILS_BYPASS=1`
is set**, because the diff it produces is deliberately one the ordinary rails-guard
PR gate denies — it only lands via the protected-base/admin path (as the manual
sweep in PR #199 did by hand). Only the `rails-freeze` blocker is completed; a
rails-less `preexisting-completed-field` ticket (one already carrying a
`completed` field) would need a field *mutation*, a distinct riskier operation
left out of scope and still only reported. Combine with `--write` to tombstone the
rails-less stale tickets and complete the rail-freezing ones in a single pass.

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
| `--tickets <path>` | Ticket-store override. The default auto-detects sharded `.adlc/tickets/` or legacy `.adlc/tickets.json`. |
| `--archive <path>` | Legacy-backend archive override. Sharded stores always use `.adlc/ticket-archive/`. |
| `--base-ref <ref>` | Git ref to check declared `scope` globs against (default `HEAD`). Point at `origin/main` to audit a feature branch's tickets against what's already shipped on trunk. |
| `--write` | Tombstone rails-less stale tickets: add `completed: true` in place (never remove, never mutate any other field). Rails-freezing stale tickets are left untouched and reported under `needsCeremony`. |
| `--ceremony` | Protected-base admin action: also complete the rail-freezing stale tickets in place (expiring their rails, T36), reported under `ceremonyCompleted`. Writes nothing unless `ADLC_RAILS_BYPASS=1` is set. |
| `--json` | Machine-readable `{ baseRef, write, ceremony, stale[], active[], tombstoned[], ceremonyCompleted[], needsCeremony[] }`. |

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Report or tombstone succeeded — regardless of how many stale tickets were found. This is advisory (like `model-ratchet`), not a pass/fail gate: stale tickets are clutter, not a merge blocker. |
| `1` | Operational error — bad/missing ticket file, invalid JSON, unresolvable `--base-ref`, the write lock could not be acquired, or `--ceremony` was invoked without `ADLC_RAILS_BYPASS=1`. |

## Examples

```bash
# Report stale tickets on the currently checked-out ref (dry-run, default)
ticket-prune

# Audit tickets against main from a feature branch
ticket-prune --base-ref origin/main --json

# Tombstone the rails-less stale tickets found above (completed:true in place)
ticket-prune --write

# Admin, on a protected-base checkout of main: complete the rail-freezing
# shipped tickets too, expiring their rails (T36). Refuses without the override.
ADLC_RAILS_BYPASS=1 ticket-prune --ceremony --write --base-ref origin/main
```

## Locking and atomicity

On sharded stores, `--write` uses the canonical ticket service's worktree lock,
hash CAS, journal, evidence, and active→archive transaction. The legacy bridge
retains the shared `.adlc/tickets.lock` plus archive-first atomic replacement so
sync and prune do not race and a ticket never disappears from both stores. Under
the lock the tool re-reads and re-classifies before writing, so a ticket another
writer un-staled in the race window is never pruned.

## Relationship to sibling tools

- **`@adlc/ticket-sync`** — writes/reads the active ticket store from an external
  tracker; shares the same lock path so a sync and a prune never interleave.
- **`model-ratchet` / `skill-rot`** — the other decay-driven, dry-run-by-default
  maintenance checks wired into `/adlc-maintain`; `ticket-prune` follows the
  same reporting contract.

## Compatibility

New repositories archive to immutable shards through `@adlc/tickets`. The old
flat active/archive pair remains writable only as the 1.x compatibility path;
use `adlc ticket store migrate` to preview the representation-only migration.
