# herdr × ADLC integration plan

Exploration and phased plan for `plugins/adlc-herdr` — a [herdr](https://herdr.dev)
plugin that makes the ADLC visible and operable from the terminal multiplexer
layer, regardless of which harness runs in each pane.

Status: **plan** (approved architecture, not yet built). Companion tickets:
`t-herdr-*` in `.adlc/tickets/`.

---

## 1. Why this is a new layer, not an 8th harness column

Every existing ADLC integration lives *inside* a harness: hooks, MCP tools,
subagents, skills (see
[`integrations/harness-capability-matrix.md`](./integrations/harness-capability-matrix.md)).
herdr sits *above* the harnesses — it is an agent multiplexer that owns the
PTYs, worktrees, tabs, and semantic agent status (`working`/`blocked`/`idle`)
for every harness at once.

That position gives a herdr plugin three things no harness integration can have:

1. **Cross-harness by construction.** The plugin never touches harness
   internals. It reads the shared `.adlc/` contract that all seven harness
   integrations already write (`current-ticket.json`, the sharded ticket store,
   `manifest.jsonl`, `fleet-status.json`) and herdr's own API. One codebase
   covers Claude Code, Codex, Pi, OpenCode, Cursor, Antigravity, Copilot — and
   any future harness — identically.
2. **A whole-herd view.** Harness integrations can only narrate their own
   session (Pi's footer pill, OpenCode's toast). herdr can show lifecycle state
   for *every* pane at once, plus a board for the backlog itself.
3. **A persistence and attach surface.** herdr sessions survive disconnects and
   attach over SSH/mobile. Whatever we surface here is automatically watchable
   from anywhere.

Consequently this is **not** an enforcement tier. Rails enforcement, context
defense, and P5 prosecution remain the harness plugins' and CI's job. The herdr
plugin observes, narrates, and offers actions — it never becomes a gate the
lifecycle depends on (see §7 non-goals).

## 2. Grounded facts

Split per the Copilot precedent (`docs/integrations/copilot-probe-appendix.md`):
what we probed live vs. what we only read in docs. Anything docs-only gets
re-probed before code depends on it.

### 2.1 Live-probed (herdr 0.7.4, this machine, 2026-07-23)

- **Runtime env inside a pane:** `HERDR_ENV=1`, `HERDR_SOCKET_PATH`
  (`~/.config/herdr/herdr.sock`), `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`,
  `HERDR_PANE_ID`.
- **Plugin system is live:** `herdr plugin
  install <owner>/<repo>[/subdir...] [--ref] [--yes] | uninstall | link <path>
  [--disabled] | unlink | list [--json] | enable | disable | config-dir |
  action <list|invoke> | log list | pane <open|focus|close>`. Zero plugins
  installed on this host — clean slate.
- **Agent semantics:** `herdr agent list | get | read [--source
  visible|recent|recent-unwrapped] | send | rename | focus | wait --status
  <idle|working|blocked|unknown> | attach [--takeover] | start <name> [--cwd]
  [--env K=V] [--split right|down] -- <argv...> | explain` (`--split` takes a
  direction argument — verified against `agent start --help` on 0.7.4).
- **Pane metadata reporting — the key UI channel:** `herdr pane report-metadata
  <pane_id> --source ID [--title TEXT] [--display-agent TEXT] [--state-label
  STATUS=TEXT] [--token NAME=VALUE] [--clear-token NAME] [--seq N] [--ttl-ms N]`
  plus `workspace report-metadata` with the same token surface. Arbitrary
  named tokens with TTL, rendered natively by herdr.
- **Worktrees are first-class:** `herdr worktree list|create|open|remove
  [--json]` with `--branch/--base/--path/--label`.
- **Blocking waits:** `herdr wait output <pane> --match <text> [--regex]
  [--timeout MS]` and `herdr wait agent-status <pane> --status
  <idle|working|blocked|done|unknown>` (note: `done` accepted here but not in
  `agent wait` — version-pin carefully).
- **Notifications:** `herdr notification show <title> [--body] [--position]
  [--sound none|done|request]`.
- **Event stream (from `herdr api schema --json`):** 25 event kinds, the ones
  we care about: `worktree_created|opened|removed`, `pane_created|closed|
  exited|focused|output_changed`, `pane_agent_detected`,
  `pane_agent_status_changed`, `workspace_metadata_updated`, plus an
  `EventMatch` subscription shape in the request schema (socket-level
  subscriptions exist).
- **Built-in harness integrations** (status detection): pi, omp, claude, codex,
  copilot, devin, droid, kimi, opencode, kilo, hermes, qodercli, cursor,
  mastracode — a superset of ADLC's seven targets.
- `herdr api snapshot` / `herdr api schema [--json]` dump live state and the
  full socket schema.

### 2.2 Docs-derived (herdr.dev/docs/plugins — re-probe before build)

- Manifest `herdr-plugin.toml`: required `id`, `name`, `version`,
  `min_herdr_version`; optional `description`, `platforms`; entrypoint arrays
  `[[build]]`, `[[startup]]`, `[[actions]]` (`id`, `title`, `contexts`,
  `command`), `[[events]]`, `[[panes]]` (placement `overlay` (default) |
  `popup` | `split` | `tab` | `zoomed`), `[[link_handlers]]` (Rust regex over
  ctrl-clicked URLs).
- Runtime env injected into plugin commands: `HERDR_BIN_PATH`,
  `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT` (read-only for GitHub installs),
  `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`,
  `HERDR_PLUGIN_CONTEXT_JSON`, `HERDR_PLUGIN_EVENT=startup`,
  `HERDR_PLUGIN_EVENT_JSON`, `HERDR_PLUGIN_ACTION_ID`,
  `HERDR_PLUGIN_CLICKED_URL`.
- Plugins are plain argv programs (any language), run **unsandboxed** as the
  user, with the full herdr CLI available — "no restricted command set."
- Marketplace = public GitHub repos tagged `herdr-plugin`, refreshed ~30 min.
  Subdir installs work: `herdr plugin install voodootikigod/adlc/plugins/adlc-herdr`.
- v1 limitations: no runtime action registration, no non-terminal UI, no
  herdr-managed plugin storage, popups have no pane IDs or lifecycle events.

### 2.3 ADLC facts the plugin builds on (this repo)

- The shared state contract every harness integration writes:
  `.adlc/current-ticket.json` / `ADLC_TICKET`, sharded ticket store
  `.adlc/tickets/`, gate-evidence ledger `.adlc/manifest.jsonl`,
  `.adlc/config.json`.
- Fleet already persists everything an observer needs, atomically
  (`packages/fleet/lib/status.mjs`): `.adlc/fleet-status.json` rewritten by
  temp+rename **after every per-ticket transition** (`building → gating →
  prosecuting → fixing → merging → merged|failed|blocked`), and per-worker
  logs at `.adlc/fleet-logs/<ticketId>.log`
  (`packages/fleet/lib/live-deps.mjs:85`). Worker worktrees live at
  `.worktrees/fleet-<id>`. **The v1 fleet bridge needs no new fleet
  machinery** — the only change is a schema-stability decision (§5.5).

## 3. Architecture decision

Three shapes were considered; **B** is approved.

- **A — pure observer, zero ADLC package contact.** Poll `.adlc/` and
  `fleet status --json` only. Fast, but per-worker fleet visibility is coarse
  and nothing stops schema drift from silently blinding the plugin.
- **B — observer bridge (chosen).** The plugin owns visibility, actions, and
  glue. Fleet stays the sole executor; the bridge *reads* `fleet-status.json`
  and tails `fleet-logs/`. The only ADLC-side change is documenting/versioning
  that read surface. Worker-spawn-in-pane is deferred behind an ADR (§8
  phase 4) because it touches fleet's sandbox/containment posture.
- **C — herdr-native orchestrator.** Plugin dispatches tickets to panes itself
  (`worktree create` + `agent start` + `wait`). Rejected: duplicates fleet's
  scheduler, gates, two-strike policy, and threat model — two orchestrators,
  one of them unsandboxed.

Why B: it converts herdr into the *UI* for the parts of ADLC that today run
blind (fleet) or per-session (tickets/gates), at near-zero risk — every write
path stays where it is, and the plugin degrades to "no data, blank tokens" if
anything is missing.

## 4. Plugin layout

`plugins/adlc-herdr/`, zero-dependency Node (repo convention, CONVENTIONS.md),
sharing nothing at runtime with the harness plugins except the `.adlc/`
contract and the `adlc` CLI.

Draft manifest (field names re-verified against live docs before build — §2.2):

```toml
# plugins/adlc-herdr/herdr-plugin.toml
id = "adlc"
name = "ADLC"
version = "0.1.0"
min_herdr_version = "0.7.4"
description = "Agentic Development Lifecycle: per-pane phase/ticket/gate status, backlog board, gate actions, and fleet run observability."
platforms = ["linux", "macos"]

[[startup]]
command = ["node", "bin/watcher.mjs"]

[[panes]]
id = "board"
title = "ADLC board"
placement = "overlay"
command = ["node", "bin/board.mjs"]

[[actions]]
id = "ticket-show"
title = "ADLC: show active ticket"
contexts = ["pane", "worktree"]
command = ["node", "bin/action.mjs"]

[[actions]]
id = "gate"
title = "ADLC: run gate for this pane's repo"
contexts = ["pane", "worktree"]
command = ["node", "bin/action.mjs"]

[[actions]]
id = "prosecute"
title = "ADLC: prosecute this worktree (P5)"
contexts = ["pane", "worktree"]
command = ["node", "bin/action.mjs"]

[[events]]
event = "worktree_created"
command = ["node", "bin/on-event.mjs"]

[[events]]
event = "pane_agent_status_changed"
command = ["node", "bin/on-event.mjs"]

[[events]]
event = "pane_exited"
command = ["node", "bin/on-event.mjs"]
```

Components:

| File | Entrypoint | Role |
| --- | --- | --- |
| `bin/watcher.mjs` | `[[startup]]` | Long-lived daemon: pane↔repo mapping, `.adlc/` watches, status tokens, fleet observer |
| `bin/board.mjs` | `[[panes]]` | Overlay TUI: backlog/DAG, gate ledger tail, fleet run view |
| `bin/action.mjs` | `[[actions]]` | One shot per invocation, dispatched on `HERDR_PLUGIN_ACTION_ID` |
| `bin/on-event.mjs` | `[[events]]` | One shot per event, dispatched on `HERDR_PLUGIN_EVENT_JSON` |
| `lib/` | — | Shared: state readers (schema-validated, fail-closed), token writer, ANSI sanitizer |

## 5. Component design

### 5.1 Watcher daemon → status tokens (the visibility core)

The startup daemon maintains a map of *pane → repo root → `.adlc/` state* and
pushes it into herdr's native UI as metadata tokens:

- Discover panes/worktrees via `herdr api snapshot`. (The plan originally named
  three sources — `api snapshot` + `worktree list --json` + `pane
  process-info` — but probing showed snapshot panes already carry
  `foreground_cwd`, so as-built the map is derived from `api snapshot` +
  `git rev-parse` alone; the other two are unused.) Refresh on the socket
  event stream (`EventMatch` subscription), with polling fallback if
  subscriptions prove awkward in 0.7.x. Repo resolution is pinned: repo root =
  `git rev-parse --show-toplevel` of the pane's cwd, and a **git worktree is
  its own root** (it has its own `.adlc/`) — never walk up to the main
  checkout. Steady-state resource bound: publishes are change-driven and
  debounced, batched per refresh, with a slow heartbeat (≥30s) — the watcher
  must not spawn a `herdr` process per event.
- Watch `.adlc/current-ticket.json`, `.adlc/manifest.jsonl`, the ticket store,
  and `.adlc/fleet-status.json` with `fs.watch` — all writers use atomic
  renames, so watches are clean.
- Publish per pane:
  `herdr pane report-metadata <pane> --source adlc --token ticket=t51 --token
  phase=P4 --token rails=armed --ttl-ms 90000` (refreshed on change and on a
  slow heartbeat; TTL makes stale state self-healing when the daemon dies).
  Repo-level facts (backlog counts, fleet run state) go to
  `workspace report-metadata`.
- **Never** calls `pane report-agent` — agent state belongs to herdr's built-in
  harness integrations; we only add lifecycle tokens beside it.

This is the piece that makes herdr's status line answer "which ticket, which
phase, gates green?" for every pane at a glance — today it only answers
"working or blocked?".

### 5.2 Board pane

`herdr plugin pane open --plugin adlc --entrypoint board` (or a keybinding) opens an overlay TUI:

- Backlog list from the ticket store (ready / in-flight / blocked-by-edges,
  `completed:true` filtered — repo invariant #104), with the ticket→pane
  mapping from §5.1 so you can see *who is building what, where*.
- Gate evidence tail from `manifest.jsonl` (most recent phase records per
  ticket).
- Active fleet run section when `fleet-status.json` exists (§5.5).
- Zero-dep ANSI rendering (same discipline as Pi's widget). Read-only in v1;
  row-level actions (focus that pane, open worktree shell) come with phase 2.

### 5.3 Actions

One-shot commands surfaced in herdr's action palette. As built, all three
declare `contexts = ["pane"]` (the draft named `["pane", "worktree"]`, but a
worktree context need not supply `focused_pane_id`, which resolution requires;
worktree-context support is deferred). Each resolves the repo from
`HERDR_PLUGIN_CONTEXT_JSON` (plus a live `pane get` for `foreground_cwd`) and
runs only fixed-argv trusted binaries from `PATH` — never a repo-local binary
(fleet's K1/A2 operator-trust rule carried over). Spawn-pane actions echo the
resolved repo + active ticket before acting; all actions fail closed (clear
notification, nothing spawned) when the context does not resolve to a repo:

- `ticket-show` — a split pane rendering the active ticket via the plugin's own
  sanitizing renderer (herdr popups are id-less singletons, so a split spawn is
  the robust shape).
- `gate` — run `adlc gate-manifest verify --json` for the pane's repo; the
  result is a **notification** (pass/FAIL + repo/ticket echo). It writes no
  tokens directly — token refresh is the watcher's job via its file watches —
  and `gate-manifest verify` writes no ledger record, so a passing/failing
  verify is surfaced only through the notification.
- `prosecute` — spawn `adversarial-review --base main` from trusted `PATH` in a
  split pane (`adlc prosecute` is the P5 evidence recorder, not a runnable
  review loop); fails closed with a notification if the binary is absent.
- (phase 2) `ticket-complete`, `adlc-init`, `fleet-status`.

### 5.4 Event glue

- `worktree_created` → if the containing repo has `.adlc/`, **offer** (via
  notification + action, never silently) to seed ticket context: set
  `ADLC_TICKET`-compatible `current-ticket.json` from the branch name when it
  matches a ticket id, or open `ticket-show`.
- `pane_agent_status_changed` → on `working → idle|done` in a pane with an
  active ticket: notification ("t51 agent went idle — gate it?") pointing at
  the `gate` action. **Advisory only** — auto-running gates on status flaps
  would make the plugin a de-facto enforcement tier, which it must not be.
- `pane_exited` → clear our tokens for that pane.

### 5.5 Fleet bridge (read-only observer)

When the watcher sees `.adlc/fleet-status.json` appear or change:

- Open (once per `runId`) a `fleet: run-<id>` tab; inside it, one read-only
  pane per in-flight ticket running `tail -F .adlc/fleet-logs/<ticketId>.log`
  (`-F`, not `-f`, so it waits for the log the orchestrator creates a beat later
  rather than exiting immediately), labeled and token-tagged with the ticket's state
  (`building|gating|prosecuting|fixing|merging`).
- Transitions → notifications: `merged` (sound `done`), `failed|blocked`
  (sound `request`) with an "open worktree shell" action targeting
  `.worktrees/fleet-<id>` — *inspect the worktree, never seize the worker
  process*.
- Panes for terminal tickets collapse to a summary row in the board.

**Required ADLC-side change (the only one):** decide the stability story for
`fleet-status.json`. It is currently an internal resumable cache (spec §6.2).
Options: (a) document + version the existing schema as a read-only observation
surface (add `schemaVersion`, note in `docs/specs/fleet-orchestration.md`), or
(b) leave it internal and have fleet emit a separate append-only
`fleet-events.jsonl`. Recommendation: **(a)** — the file already has exactly
the right granularity, and a version field keeps the observer honest
(unknown version → observer degrades to `fleet status --json` polling, fail
soft). A phase-3 ticket carries this decision.

### 5.6 Link handlers (deferred)

herdr link handlers only fire on ctrl-clicked **URLs**. Ticket ids in plain
output (`t51`) don't qualify. A later slice can teach ADLC CLIs to print
`adlc://ticket/t51` links and register a handler — deferred until the URL
scheme is worth committing to (phase 4).

## 6. Security & threat model

The plugin runs unsandboxed as the user (herdr v1 has no plugin sandbox), so
the posture is: **read broadly, write narrowly, execute only allowlisted
things.**

1. **Ticket text is untrusted input rendered into terminals.** Ticket bodies,
   branch names, and log lines pass through the board pane, tokens, and
   notifications. Every string is ANSI/OSC-escape-stripped before any
   `report-metadata`, `notification show`, or board render (terminal escape
   injection in a multiplexer is an escalation channel — same lesson class as
   the repo's text-scanning-gate rules). This sanitizer is rail-worthy: freeze
   its tests in P3.
2. **Never execute from observed state.** Nothing read from `.adlc/`,
   `HERDR_PLUGIN_EVENT_JSON`, or pane output is ever passed to a shell.
   Actions run a fixed argv (`adlc`, `tail`, `herdr`) resolved from trusted
   `PATH`; repo config cannot name executables (fleet K1/A2 rule).
3. **Schema-validate, fail closed on parse, fail soft on absence.** Malformed
   `fleet-status.json`/tickets → the observer reports "unreadable" tokens and
   stops; missing files → blank state, no errors. The plugin must never crash
   the herdr session or spam notifications on garbage input.
4. **No enforcement role.** The plugin's absence changes nothing about rails,
   gates, or CI. It never writes `.adlc/` state in v1 except via explicit
   user-invoked `adlc` actions (which carry their own dry-run defaults).
5. **Version drift.** herdr is pre-1.0 and moving (CLI shapes differ between
   docs and 0.7.4 already — `done` status discrepancy, §2.1).
   `min_herdr_version` pins the floor; every herdr CLI call goes through one
   `lib/herdr.mjs` shim so a CLI change is a one-file fix (mirrors the fleet
   adapter override design); unknown output shapes fail soft. The daemon also
   checks `herdr --version` at startup against its tested ceiling and degrades
   to a single "untested herdr version" workspace token (no crash, no spam)
   when the host is newer.
6. **Install-time `[[build]]` commands: none.** The plugin ships runnable
   (zero-dep Node) so `herdr plugin install` executes nothing at install
   beyond registration.

## 7. Non-goals

- Not an enforcement tier — no rails-guard, no build-gate, no deny path.
- Not an orchestrator — fleet owns scheduling, gates, merges (approach C
  rejected).
- Not a harness integration — no hooks/MCP/subagents; the capability matrix
  keeps seven columns and herdr gets its own doc page when it ships.
- No herdr-side persistence beyond `HERDR_PLUGIN_STATE_DIR` scratch (dedup of
  seen runIds/notifications).

## 8. Phased roadmap

Phase 1 is ticketed (`.adlc/tickets/t-herdr-*`); later phases are directional
and get ticketed when they start.

**Phase 1 — see the lifecycle (tickets t-herdr-1..t-herdr-4):**
1. `t-herdr-1` scaffold: plugin dir, manifest, `lib/herdr.mjs` shim, ANSI
   sanitizer + frozen tests, offline manifest-shape smoke test, README.
2. `t-herdr-2` watcher daemon + status tokens (§5.1).
3. `t-herdr-3` actions: `ticket-show`, `gate`, `prosecute` (§5.3).
4. `t-herdr-4` board pane v1 (§5.2).

**Phase 2 — glue:** event handlers (§5.4), board row-actions,
`ticket-complete`/`adlc-init` actions, keybinding docs.

**Phase 3 — fleet observer:** the `fleet-status.json` schema decision (§5.5),
then the run tab/tail-pane/notification bridge.

**Phase 4 — ADR-gated ambitions:**
- Worker-spawn-in-pane mode (fleet workers as attachable herdr panes) — needs
  an ADR reconciling herdr-owned PTYs with fleet's sandbox planes and
  operator-trust rules.
- `adlc://` link scheme + handlers (§5.6).
- Marketplace listing (`herdr-plugin` topic tags the whole monorepo — decide
  whether that's acceptable or the plugin gets a mirror repo).
- Docs-site integration page + `integration-facts` entry (guard currently
  only pins registered integrations, verified 2026-07-23).

## 9. DX walkthroughs (what this buys)

- **Solo, three worktrees, three harnesses.** Status line shows
  `t51 · P4 · rails armed` / `t52 · P5` per pane without asking any agent
  anything. An agent goes idle → notification suggests gating. Prosecute is a
  palette action away, in the right worktree, every time.
- **Fleet run, visible.** `fleet run --concurrency 4` stops being a black box:
  a tab appears with four live worker logs, tokens flip
  `building → gating → prosecuting → merging`, merges chime, failures raise a
  notification whose action drops you into the failed worktree — from any
  machine you can `herdr --remote` into.
- **Cross-harness bake-off.** Two panes, same ticket, Claude Code vs Codex —
  the tokens and board make the race legible; the observer doesn't care which
  harness is which.

## 10. Acceptance criteria (Phase 1)

- AC1 — The full plugin test suite passes offline, with no herdr server, no
  network, and no npm install. Verification:
  `node --test 'plugins/adlc-herdr/test/*.test.mjs'` (glob form — the bare
  directory form fails on Node 24).
- AC2 — The manifest is shape-valid: required fields present, every declared
  entrypoint file exists and passes syntax check. Verification:
  `node --test plugins/adlc-herdr/test/manifest.test.mjs`.
- AC3 — The sanitizer strips ANSI/OSC/C1/control escapes from any string bound
  for a terminal; its tests are frozen rails. Verification:
  `node --test plugins/adlc-herdr/test/sanitize.test.mjs`.
- AC4 — The watcher maps panes to repos and publishes ticket/phase tokens with
  TTL, failing soft on missing `.adlc/` and closed (explicit unreadable token)
  on malformed JSON. Verification: `watcher.test.mjs` (state/token helpers),
  `panemap.test.mjs` (pane→repo mapping), `watch-plan.test.mjs` (token
  assembly + multi-repo workspace aggregation), and `watcher-e2e.test.mjs`
  (the daemon driven end-to-end against a scripted `herdr` stub — publishes the
  expected tokens and never emits `report-agent`).
- AC5 — Actions dispatch on `HERDR_PLUGIN_ACTION_ID`, resolve the repo from
  validated context JSON, and spawn only fixed-argv trusted binaries.
  Verification: `node --test plugins/adlc-herdr/test/action.test.mjs`.
- AC6 — The board renders backlog, mapping, and gate-ledger sections from
  sanitized data. Verification: `node --test plugins/adlc-herdr/test/board.test.mjs`.
- AC7 — Live install smoke (operator-run, not CI — Copilot live-smoke
  precedent): `herdr plugin link plugins/adlc-herdr` then
  `herdr plugin list --json` shows plugin id `adlc` enabled, and the board pane
  opens via `herdr plugin pane open --plugin adlc --entrypoint board`.

## 11. Known limitations (accepted for Phase 1)

- **Synchronous repo-root resolution.** `resolveRepoRoot` shells out to
  `git rev-parse --show-toplevel` via `execFileSync` (5s timeout). On a slow
  or unresponsive filesystem (NFS/FUSE) the first resolution of a directory can
  block the event loop for up to that timeout. Mitigated by the resolver cache
  — git runs **once per new directory** (positive results are cached
  permanently, negatives for 30s), so steady-state refreshes and the board's
  redraw do not re-invoke git. Surfaced by the cross-model prosecution (round
  8, HIGH). Deferred rather than fixed in Phase 1 because making it async
  ripples through `buildPaneMap` and `resolveTarget`, both **frozen rails**
  (t-herdr-2 / t-herdr-3); the async conversion is a tracked fast-follow that
  will amend those rail contracts deliberately.

## 12. Open questions

1. Socket `EventMatch` subscription ergonomics from a plugin daemon (probed
   schema only) — if awkward, v1 falls back to `api snapshot` polling.
2. `[[panes]]` TUI contract details (stdin/resize/exit semantics) — docs-only
   today; probe with a hello-world pane in `herdr-1`.
3. Exact `report-metadata` rendering (where tokens appear, ordering, length
   budget) — probe in `herdr-2`; token names may need shortening.
4. Whether `herdr plugin link` can run in CI for an install smoke, or the live
   smoke stays operator-run like Copilot's (`ADLC_COPILOT_LIVE_INSTALL`
   precedent).
