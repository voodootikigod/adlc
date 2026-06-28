# @adlc/ticket-sync

Two-way sync between ADLC tickets (`.adlc/tickets.json`) and an external tracker —
**GitHub Issues** first. Import issues into tickets, create issues for local-only
tickets, and write ADLC execution metadata back into the issue body. Dry-run by
default; all network I/O goes through the `gh` CLI.

```bash
npm i -g @adlc/ticket-sync
gh auth login                       # the provider shells out to gh
adlc-ticket-sync --help
```

## Commands

| Command | What it does |
|---|---|
| `adlc-ticket-sync pull` | Import issues → `.adlc/tickets.json` (3-way reconcile; unions; fails closed on conflict). |
| `adlc-ticket-sync push` | Write tickets back: update synced issues + **idempotent create** for local-only tickets + display-only status labels/comment. |
| `adlc-ticket-sync sync` | `pull` then `push` (a non-clean pull aborts before push). |
| `adlc-ticket-sync doctor` | Read-only, offline health checks (config / tickets / schema drift / sidecar / stale lock). |

Dry-run by default — pass `--write` to apply. `--json` on all commands.
Exit codes: `0` ok · `1` operational · `2` blocked.

```bash
adlc-ticket-sync pull               # preview the import
adlc-ticket-sync pull --write       # apply it
adlc-ticket-sync push --write       # create/update issues + status
adlc-ticket-sync doctor             # check repo health, read-only
```

## How it works

- **Metadata** GitHub Issues lack lives in a fenced JSON **block** in the issue body,
  between `<!-- adlc:begin … -->` / `<!-- adlc:end -->` sentinels. Prose around it is
  preserved verbatim.
- **Sync bookkeeping** (node ids, the 3-way base hash, create keys) lives in a
  gitignored, rebuildable **sidecar** (`.adlc/ticket-sync.state.json`) — so routine
  syncs never touch the rails trust root.
- **Idempotent create**: a stable sentinel key + a pre-create adoption scan +
  `pendingCreates` crash-recovery mean a re-run never duplicates an issue. On create,
  the ticket id is reassigned `T<n>` → `gh:<owner>/<repo>#<n>` with a store-wide edge
  rewrite.
- **Offline-first**: all logic is tested offline via an injected `gh` runner; the one
  live edge has an opt-in smoke (`scripts/ticket-sync-smoke.mjs`).

## Token scopes

`pull` needs `issues:read`; `push` needs `issues:write`. Prefer a fine-grained PAT
over the broad `repo` scope. `GH_HOST` is honored for GitHub Enterprise.

## Full guide

See **[docs/ticket-sync.md](../../docs/ticket-sync.md)** for the flag matrix, config
reference, the block/sidecar formats, idempotency details, the rails-trust-root
interaction, and the live smoke.

## License

MIT © Chris Williams (@voodootikigod)
