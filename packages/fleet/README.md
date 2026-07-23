# @adlc/fleet

Parallel ticket orchestration on the ADLC. The fleet reads the ready tickets from
`.adlc/tickets.json`, dispatches each to a sandboxed headless **Claude Code**
worker in an isolated git worktree, runs the deterministic gates, prosecutes the
change with a blocking cross-model review, and merges it into a per-run
integration branch — with **deterministic control flow** (ADLC D0: control flow
is code, judgment is models). No LLM call decides ordering, retries, or merges.

Design contract: [`docs/specs/fleet-orchestration.md`](../../docs/specs/fleet-orchestration.md)
· decisions & threat model: [`docs/adr/0010-adlc-fleet-orchestration.md`](../../docs/adr/0010-adlc-fleet-orchestration.md).

## What it does

- **Plan source is `.adlc/tickets.json` itself** (via `@adlc/core`) — not a new
  format. `completed:true` tickets are filtered (repo invariant #104) but still
  satisfy edges. Scope-overlapping tickets are serialized; a single writer holds
  a partition at a time.
- **Sandboxed repo-command plane** — init, build, and test commands run inside an
  OS sandbox (network denied, reads/writes bounded to the worktree, synthetic
  HOME). The fleet fails closed if no sandbox backend is available.
- **Model plane** — the `claude -p` worker runs with provider-only egress and its
  own auth so it can function; it is *not* wrapped in the no-network sandbox.
- **Deterministic pre-merge gates** — build/test, `rails-guard`, a ticket-local
  scope check, and a closed protected-control-file integrity scan (covering the
  `.adlc/tickets.json` trust root).
- **Blocking cross-model prosecution** — every ticket must clear an
  `adversarial-review` pass before merge; it fails closed if no provider is
  reachable.
- **Integration branch, never base** — finished tickets merge sequentially into
  `fleet/run-<runId>`; the fleet opens at most one PR to base and never pushes.
- **Auto-completes on a passing merge gate** — once a ticket's post-merge gate
  passes, the fleet marks it `completed:true` on the integration branch via the
  same `adlc ticket complete` (`planComplete` + apply) path a human would use, so
  the add-only annotation and its manifest evidence ride the single PR. Idempotent
  (an already-completed ticket is a no-op) and gated (a gate-failed ticket stays
  open).
- **Two-strike failure policy** informed by `flail-detector` (fails open).

## Usage

```sh
fleet run --dry-run                 # preview the plan; no worktrees, no workers
fleet run --dry-run --json          # machine-readable plan
fleet run [--concurrency N] [--tickets T1,T2] [--base main]
fleet status [--json]               # show the current run's per-ticket state
fleet unlock                        # release a stale run lock (guarded)
```

### Dry-run smoke (AC5)

Against this repo's real backlog:

```sh
node packages/fleet/bin/fleet.mjs run --dry-run
```

exits `0`, prints the ready set + first dispatch batch + tickets waiting on deps,
excludes `completed:true` tickets, and creates no worktrees (`git worktree list`
is unchanged).

### Live run — prerequisites

A live `fleet run` (no `--dry-run`) requires:

1. an **OS sandbox backend** on the host (`bwrap`/`unshare` on Linux,
   `sandbox-exec` on macOS), or an operator-local `--i-am-in-a-disposable-container`
   asserting the whole run is already isolated (a committed repo config can never
   set this);
2. the **ADLC Claude Code plugin** installed so the in-session rail hook arms
   inside worker worktrees (`ADLC_P4_ENFORCEMENT=1` + `ADLC_TICKET`);
3. a **Claude Code** binary (`claude`) on `PATH`;
4. a **trusted `adversarial-review`** binary resolvable on the orchestrator's
   `PATH` (or a pinned `fleet.reviewBin`) — the blocking prosecution runs it by
   name against a trusted PATH, never `npx` from the worker worktree, so a worker
   cannot shadow the prosecutor. If it is not resolvable, prosecution fails closed
   and no ticket merges;
5. `fleet.gate` configured under the `fleet` key of `.adlc/config.json`.

The fleet refuses to dispatch when the sandbox precondition is unmet (fail
closed).

## Worker harnesses (adapters)

The scheduler is harness-blind: it talks to workers through a `WorkerAdapter`
seam (`lib/adapters/`), so which coding agent builds a ticket is a config choice,
not a code change. Registered adapters: `claude-code` (default), `codex`, `agy`
(Google Antigravity), `opencode`, `pi`, `cursor`. Each is a pure I/O shim that
spawns its harness in headless mode on the **model plane** (provider egress + its
own auth, never sandboxed — K2). Select one with the **operator-local** `--adapter`
flag (default `claude-code`).

**The harness is operator-local, not repo config (adversarial-review K1/A2):** only
`claude-code` installs a per-worktree permission allowlist, so a repo-committed
`fleet.adapter`/`fleet.adapterCommand` could silently move unattended workers onto a
less-contained harness. Choosing the harness (and any binary override) is therefore an
operator trust decision — set via `--adapter` / `--adapter-command` / `--adapter-args`;
a value in `.adlc/config.json` is ignored with a warning. Only `model` and `adapterStdin`
(non-executable data) are read from repo config.

Each adapter ships a grounded **default invocation** (`agy --print` is verified
against antigravity-booster; `codex exec`, `opencode run`, `cursor-agent -p`, and
the pi headless form are documented defaults with the confidence noted in each
adapter's header). Because harness CLIs evolve, the command and args are
**overridable** via the operator-local `--adapter-command` / `--adapter-args` CLI
flags (and `fleet.model` for agy, which is non-executable data) — so a CLI change
is a one-line fix, and an unknown `--adapter` fails closed at run start. Live
end-to-end behavior per harness should be verified against the installed CLI.

## Configuration (`.adlc/config.json`)

```json
{
  "fleet": {
    "gate": { "build": "npm run build --workspaces --if-present", "test": "npm test" },
    "init": "npm install",
    "model": null,
    "adapterStdin": false,
    "concurrency": 2,
    "base": "main",
    "timeoutMinutes": 30,
    "prosecuteFailOn": "medium",
    "allowedCommands": ["npm test", "npm run build:*", "node --test *"]
  }
}
```

## Exit codes

- `0` — every dispatched ticket merged (or a clean dry-run).
- `1` — operational error (bad config, dirty tree, lock held, missing gate,
  sandbox precondition unmet).
- `2` — at least one ticket failed or was blocked.

## ADLC phase

P4 (parallel build) + P5 (per-ticket prosecution). The fleet is the orchestrator
that makes ADLC P4 parallelism executable; it consumes the ticket DAG certified
by `merge-forecast` (D2) and routes each ticket through the gates.

## Core gaps

None required core changes. The fleet delegates all ticket primitives
(`loadTickets`, `topoSort`, `scopesOverlap`, `globMatch`, `inScope`) to
`@adlc/core` and adds no third-party runtime dependency.
