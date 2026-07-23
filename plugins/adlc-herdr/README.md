# adlc-herdr

ADLC surfaced at the terminal-multiplexer layer. A [herdr](https://herdr.dev)
plugin that shows lifecycle state (active ticket, phase, gate evidence) for
every pane regardless of which harness runs in it, offers gate/prosecute/ticket
actions from the pane context, and (phase 3) turns `adlc-fleet` runs into
watchable tabs.

Design and roadmap: [`docs/herdr-integration-plan.md`](../../docs/herdr-integration-plan.md).
This is **not** an enforcement tier and **not** a harness integration — it
observes the shared `.adlc/` contract that all seven harness plugins write,
plus herdr's own API. The capability × harness matrix keeps seven columns.

## Status

| Piece | Ticket | State |
| --- | --- | --- |
| Manifest, herdr CLI shim, sanitizer rail | t-herdr-1 | shipped |
| Watcher daemon → per-pane status tokens | t-herdr-2 | planned |
| Actions: ticket-show / gate / prosecute | t-herdr-3 | planned |
| Board pane | t-herdr-4 | planned |

## Install

Local development (registers the working directory, runs no build):

```sh
herdr plugin link /path/to/adlc/plugins/adlc-herdr
```

From GitHub (subdir install):

```sh
herdr plugin install voodootikigod/adlc/plugins/adlc-herdr
```

Requires herdr ≥ 0.7.4 (`min_herdr_version`). The plugin is zero-dependency
Node and declares no `[[build]]` commands — installation executes nothing.

## Layout

- `herdr-plugin.toml` — manifest. v0.1.0 registers identity only; entrypoints
  land with their tickets.
- `lib/herdr.mjs` — the single shim every herdr CLI call goes through: fixed
  argv arrays, no shell, `HERDR_BIN_PATH`-or-`herdr` binary resolution,
  runtime failures fail soft. When a herdr release changes CLI shape, this is
  the one file to fix.
- `lib/sanitize.mjs` — strips ANSI/OSC/C1/C0 escapes from every string the
  plugin renders into a terminal. Ticket bodies and log lines are untrusted;
  escape injection in a multiplexer is an escalation channel.
- `lib/manifest.mjs` — zero-dep parser/validator for the manifest's TOML
  subset; backs the offline smoke test.
- `test/` — `node --test 'plugins/adlc-herdr/test/*.test.mjs'` runs offline
  (no herdr server, no network, no install; use the glob form — the bare
  directory form fails on Node 24). `sanitize.test.mjs` and
  `herdr-shim.test.mjs` are frozen rails (t-herdr-1).

## Probed facts

Grounded against herdr **0.7.4** live on 2026-07-23 (plan §2.1) and the
plugin docs re-probe of the same date: manifest `command` values are argv
arrays; `[[events]]` uses dotted names (`on = "worktree.created"`) while the
socket schema uses underscores (`worktree_created`); `wait agent-status`
accepts `done` but `agent wait --status` does not. Re-verify against the
installed herdr before extending the shim.

## Live smoke (AC7 — operator-run, not CI)

```sh
herdr plugin link "$(pwd)/plugins/adlc-herdr"
herdr plugin list --json   # expect id "adlc", enabled
```

Record the result with
`adlc gate-manifest record herdr-live-smoke --ticket <ticket>`. The board-pane
step (`herdr plugin pane open adlc board`) applies from t-herdr-4 onward.
