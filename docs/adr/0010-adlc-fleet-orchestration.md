# ADR 0010 — @adlc/fleet: parallel ticket orchestration on the ADLC

Status: Accepted (2026-07-12)
Ticket: T42
Spec: [docs/specs/fleet-orchestration.md](../specs/fleet-orchestration.md)

## Context

The ADLC lifecycle ran linearly (one ticket per interactive session) even though
the doctrine and data model already contemplate parallelism: ADLC.md describes P4
as "parallel worktrees, single writer per partition", `merge-forecast` certifies
fan-out width from the ticket DAG, and `@adlc/core` ships
`topoSort`/`computeFloat`/`scopesOverlap` over `.adlc/tickets.json`. What was
missing is the orchestrator that dispatches ready tickets to headless workers and
walks them through the gates. A working agy-specific reference exists in
`antigravity-booster`; this ADR records generalizing its mechanics into a
first-class, harness-agnostic package.

## Decision

1. **New package `packages/fleet` (`@adlc/fleet`)**, per CONVENTIONS.md. No
   third-party runtime dependency — `@adlc/core` is the sole dependency, imported
   via the `@adlc/core` workspace specifier (the repo's universal convention; the
   older "relative path" wording in CONVENTIONS.md is followed by no package and
   is treated as stale). `antigravity-booster` may later consume this package.
2. **Plan source is `.adlc/tickets.json` itself** — not a new format. The fleet is
   a new backlog consumer and filters `completed:true` (invariant #104) while
   still honoring completed tickets as satisfied edge prerequisites. Scope,
   rails, edges, and duration are interpreted exactly as `@adlc/core` defines
   them.
3. **Deterministic control flow.** The scheduler is plain Node; no LLM call
   decides ordering, retries, or merges (ADLC D0). Every world-effect (dispatch,
   gate, prosecute, merge, git) is injected, so the state machine is unit-tested
   directly.
4. **Claude Code is the sole v1 worker**, behind a `WorkerAdapter` seam so
   codex/agy/opencode/pi/cursor adapters can be added without touching the
   scheduler.
5. **Blocking cross-model prosecution in v1** — every ticket clears an
   `adversarial-review` pass before merge; fails closed if no provider is
   reachable.
6. **Merge to a per-run integration branch (`fleet/run-<runId>`), never base**;
   one PR at run end; the fleet never pushes.
7. **Sandbox required for the repo-command plane** (init/build/test); the worker
   runs on a separate model plane with provider egress. Fails closed with no
   sandbox unless an operator-local `--i-am-in-a-disposable-container` override is
   set (repo-committed config can never set it).

## The WorkerAdapter interface

The scheduler is harness-blind. An adapter module exports:

```js
export const name = 'claude-code';      // adapter id, recorded in run status
export const pool = 'default';          // concurrency pool this adapter draws from

// Optional: prepare the worktree before dispatch (write settings/charter files).
export function provision({ worktree, ticket, config }) {}

// Required: run one build attempt to completion. Enforces its own timeout, must
// not write outside `worktree`. Returns { exitCode, output, timedOut }.
export function dispatch({ worktree, prompt, timeoutMs, env }) {}
```

Adapters are pure I/O shims: no retry, gate, or git logic — all of that is
scheduler policy, so future adapters inherit it unchanged. The v1 `claude-code`
adapter provisions `.claude/settings.local.json` (an allowlist translated into
Claude Code permission-rule form) and dispatches
`claude -p … --permission-mode acceptEdits` on the **model plane** (provider
egress + its own auth), explicitly NOT wrapped in the no-network repo-command
sandbox — otherwise it could never authenticate.

## Threat Model

An unattended fleet of writers is a new blast-radius surface. Containment layers,
outermost first:

1. **Worktree isolation** — workers never touch the main checkout; the
   orchestrator alone commits/merges. A destroyed worktree costs one strike.
2. **OS sandbox on the repo-command plane** — init/build/test run network-denied
   with reads and writes bounded to the worktree (synthetic HOME, host credential
   dirs unmounted). Fails closed if unavailable. This contains the arbitrary code
   a test suite or `npm install` executes.
3. **Permission allowlist** — the worker's shell is limited to allowlisted
   commands; no `git commit`, no package installs, no network unless named.
4. **Rails + trust root, in-session** — `ADLC_P4_ENFORCEMENT=1` arms the plugin
   hook that denies structured edits to rails, `.adlc/tickets.json`, and
   `.claude/**`/`.adlc/**`.
5. **Deterministic pre-merge gates** — build/test, `rails-guard`, the ticket-local
   scope check, and a **closed protected-control-file integrity scan** that
   byte-compares the worktree copy of each control file — including the
   `.adlc/tickets.json` trust root — catching Bash-spelled edits the in-session
   hook cannot parse. Nothing merges on a worker's say-so.
6. **Blocking cross-model prosecution** — a fresh-context, cross-provider
   `adversarial-review` must clear each ticket before merge; fails closed with no
   provider.
7. **Integration branch, never base** — base is reached only through the human P6
   review of the single PR from `fleet/run-<runId>`, backed by per-ticket
   prosecution.
8. **Prompt-injection fencing** — gate logs, prior-failure context, and
   prosecution findings enter charters only inside unguessable UNTRUSTED fences;
   verdict text (`TICKET-DONE`, a review verdict) is never trusted — gates
   re-verify everything.
9. **Resource bounds** — per-attempt timeout, concurrency cap, two-strike cap,
   and a single-instance repo lock (PID-reuse-proof stale recovery) bound runaway
   cost.

Residual risks (v1): a misconfigured `--i-am-in-a-disposable-container` claiming
isolation a container does not provide (loud logging mitigates), and a
cross-model reviewer missing a subtle in-scope defect (the single-PR human review
remains the final backstop; the fleet never pushes to base autonomously).

## P5 code-review hardening

A cross-model (codex/GPT) adversarial review of the *built* code — distinct from
the six-pass design review — found four implementation defects the design review
could not see; all were fixed before merge:

- **C1**: the protected-control-file scan was defined and unit-tested but never
  invoked in the run path. Fixed by composing `lib/gate-pipeline.mjs`
  (build/test → scope check → protected-path scan → rails-guard) and wiring it as
  the gate effect, with an end-to-end test proving a worker's worktree mutation of
  `.adlc/tickets.json` fails the ticket before merge.
- **C2**: plain `unshare --net` was accepted as a full sandbox backend but gives
  no filesystem isolation. Fixed by accepting only `bwrap`/`sandbox-exec`; an
  `unshare`-only host now fails closed.
- **C3**: stale-lock reclaim had a rm-then-mkdir TOCTOU race. Fixed with an atomic
  rename-aside so exactly one racer reclaims.
- **C4**: `runFleet` executed tickets serially. Fixed with an async worker pool —
  builds/gates/prosecution run concurrently up to the cap while merges serialize
  through a mutex — with a test proving two non-overlapping tickets build at once
  and scope-overlapping tickets still serialize.

## Consequences

- The ADLC gains an executable P4/P5 orchestrator that dogfoods its own gates.
- The `WorkerAdapter` seam keeps additional harnesses out of the scheduler.
- Follow-on tickets: codex/agy/opencode/pi/cursor adapters, per-model quota
  pools, the multi-candidate `consensus-fix` fix fan-out, and additional sandbox
  backends.
