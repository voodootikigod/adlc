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
| Watcher daemon → per-pane status tokens | t-herdr-2 | shipped |
| Actions: ticket-show / gate / prosecute | t-herdr-3 | shipped |
| Board pane | t-herdr-4 | shipped |

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

### About the npm package

`@adlc/herdr` is published to npm alongside the rest of the suite, but **npm is
not an install path for this plugin** — herdr resolves plugins from a GitHub
subdirectory or a local directory, and has no `npm:` source scheme. The package
exists so the integration is discoverable next to its siblings and so its
version tracks the suite; installing it with `npm i @adlc/herdr` gives you the
files but does not register anything with herdr. Use one of the two commands
above.

## Keybindings

The board and the palette actions are reachable from herdr's action palette out
of the box; these are the *recommended* bindings to add to your herdr keymap so
the common flows are one keystroke. Bindings invoke a plugin entrypoint by id —
they never shell out — so they inherit the same trusted-PATH, fail-closed
guarantees as the palette.

| Suggested key | Binding | What it does |
| --- | --- | --- |
| `<leader> a b` | `plugin pane open --plugin adlc --entrypoint board` | Open the **board** overlay (backlog · pane map · gate ledger) |
| `<leader> a t` | `plugin action invoke --plugin adlc --action ticket-show` | **ticket-show** — split pane rendering the pane's active ticket |
| `<leader> a g` | `plugin action invoke --plugin adlc --action gate` | **gate** — notify pass/FAIL of `gate-manifest verify` for the repo |
| `<leader> a p` | `plugin action invoke --plugin adlc --action prosecute` | **prosecute** — spawn the P5 `adversarial-review` in a split |
| `<leader> a c` | `plugin action invoke --plugin adlc --action ticket-complete` | **ticket-complete** — preview completing the active ticket (dry-run; you drive the write) |
| `<leader> a i` | `plugin action invoke --plugin adlc --action adlc-init` | **adlc-init** — bootstrap `.adlc/` in the pane's repo |

Inside the **board** overlay: `↑`/`↓` (or `k`/`j`) select a ticket row, `Enter`
focuses that ticket's pane when it is mapped, `q` closes it.

## Terminal width

The board never emits a row wider than the pane, because a wrapped line breaks
the cursor-home redraw and corrupts the frame on every refresh.

One case cannot be measured, only declared. Characters classified
East_Asian_Width=AMBIGUOUS — circled digits, Greek, Cyrillic, the degree sign —
occupy **one** cell on most terminals and **two** on a terminal configured for
East Asian text. That is a terminal and font setting, not a property of the
text, so there is nothing to detect. The board assumes narrow, which is correct
for the large majority; assuming wide would shrink every row for everyone else.

If your terminal renders ambiguous characters double-width, say so:

```bash
herdr plugin pane open --plugin adlc --entrypoint board \
  --env ADLC_HERDR_AMBIGUOUS_WIDTH=wide
```

As a keybinding:

| Binding | Command |
| --- | --- |
| `<leader> a b` | `plugin pane open --plugin adlc --entrypoint board --env ADLC_HERDR_AMBIGUOUS_WIDTH=wide` |

Without it, a ticket title full of ambiguous characters can still exceed the
pane on such a terminal. Everything the board itself draws — separators, key
hints, the elision marker — is ASCII, so the chrome is exact either way.

## Layout

- `herdr-plugin.toml` — manifest (v0.2.0): identity plus the shipped
  entrypoints — `[[startup]]` watcher, `[[panes]]` board, and three
  `[[actions]]`. `[[events]]` is deferred to Phase 2.
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

Watcher-specific probes (2026-07-23, same host): pane objects carry both
`cwd` (launch dir) and `foreground_cwd` (live process cwd — use this for repo
mapping); the `tokens` key is **absent** when no tokens are set, and
`--ttl-ms` applies to every token in the call (expiry removes the key);
`report-metadata` succeeds silently and accepts 300-char values (we cap at 64
anyway). The socket speaks newline-delimited JSON: `{id, method:
"events.subscribe", params: {subscriptions: [{type: "pane.updated"}, …]}}`
(dotted wire names) is acked with `subscription_started`, then events stream
as `{data: {pane: {…}}}` objects — ~25 events in 2.5s on a busy session, so
the watcher debounces and never spawns a process per event.

Pane-entrypoint probes (2026-07-23, same host): open with `herdr plugin pane
open --plugin adlc --entrypoint board`. The overlay is a **real PTY with its
own pane id** (stdin/stdout are TTYs, live columns/rows, resize events fire),
receives `HERDR_PLUGIN_ENTRYPOINT_ID` plus the same context JSON as actions —
`focused_pane_id` is the pane that was focused at open (`invocation_source:
"api"`) — and **the pane closes when the entrypoint process exits**. Never
emit `\x1b[2J` in a pane: herdr's emulator leaves the pane blank and `pane
read` empty — redraw with cursor-home + per-line `\x1b[K` + trailing
`\x1b[0J` instead. Action probes: dispatch on `HERDR_PLUGIN_ACTION_ID`; the
context's `focused_pane_cwd` is the launch cwd, so live `foreground_cwd`
still comes from `pane get`. Manifest changes require a re-link; `bin/*.mjs`
changes are picked up live.

## Live smoke (AC7 — operator-run, not CI)

```sh
herdr plugin link "$(pwd)/plugins/adlc-herdr"
herdr plugin list --json   # expect id "adlc", enabled
```

Record the result with
`adlc gate-manifest record herdr-live-smoke --ticket <ticket>`. Open the board
with the probed flag form (matches the "Probed facts" section above):

```sh
herdr plugin pane open --plugin adlc --entrypoint board
```
