# Fleet Orchestration — `@adlc/fleet` (parallel ticket execution on the ADLC)

Status: PROPOSED (P1 — pending G1 user approval; no implementation code may be
written until the Approval line below is filled in)
Ticket: T42
Approval: APPROVED by chris@voodootikigod.com 2026-07-12 (P1 G1). Gated by
`adlc spec-lint` (14/14) + premortem (5 findings folded) + a 6-pass cross-model
`adversarial-review` loop (codex/GPT provider) that converged 5→5→2→1→1→0 to a
clean APPROVE. Decisions §0.5–0.7 (blocking prosecution, integration-branch
merge, sandbox) reflect the "tighten v1 first" hardening pass.
Inputs: antigravity-booster (`../antigravity-booster`, the agy-specific reference
implementation), ADLC.md (P4 doctrine, appendix D2 fan-out mechanics),
CONVENTIONS.md, `@adlc/core` ticket primitives, and three user decisions recorded
in §0.

## 0. Decisions already made (do not relitigate)

1. **New package** `packages/fleet` (`@adlc/fleet`) in this repo, per
   CONVENTIONS.md. antigravity-booster later becomes a consumer/sibling; it is
   not modified by this work.
2. **Spec before code**: this document passes `adlc spec-lint` + premortem and
   receives explicit user approval before any `packages/fleet` code is committed.
3. **Claude Code headless is the only v1 worker** (`claude -p`), behind a
   `WorkerAdapter` seam (§4) so codex/agy/opencode adapters can be added without
   touching the scheduler.
4. **Worker permissions** (user decision): `--permission-mode acceptEdits` plus a
   fleet-seeded settings allowlist (§7.2). No `dangerously-skip-permissions`,
   ever.
5. **Blocking prosecution in v1** (user decision, hardened past the original
   stub — closes adversarial-review F3): after the deterministic build/test/rails
   gates, every ticket is prosecuted by a **real, blocking** cross-model
   `adversarial-review` pass before it may merge; blocking findings send the
   ticket to the fix loop (§8.4). The seam is filled, not stubbed.
6. **Merge to an integration branch** (user decision, hardened past merge-to-base
   — mitigates adversarial-review F3): finished tickets merge sequentially into a
   per-run `fleet/run-<runId>` integration branch, **never directly into base**.
   The fleet opens exactly one PR (or leaves the branch for review) at run end;
   base is never written by the fleet (§9).
7. **Sandbox required on BOTH planes** (user decision — closes adversarial-review
   F2; refined by the K2 two-plane split; completed by issue #395): the
   arbitrary-code surface — the init command and every build/test/gate command —
   runs inside an OS sandbox (network-disabled, reads/writes bounded to the
   worktree, synthetic HOME). The `claude -p` worker runs on a separate model
   plane that keeps network egress and its own auth so it can function, but whose
   **writes are likewise bounded** to the worktree plus its harness's declared
   state directories — network and filesystem are independent axes, and K2 only
   ever required the network one to differ (§7.3). The fleet **refuses to
   dispatch** (fails closed, exit 1) if a sandbox is not detected/available,
   unless explicitly overridden for a disposable-container environment; that one
   decision covers both planes (§7.3).

## 1. Goals / non-goals

**Goals**

- Make ADLC P4 parallelism executable: dispatch every *ready* ticket from
  `.adlc/tickets.json` to an unattended Claude Code worker in an isolated
  worktree, gate it, and merge it — with deterministic control flow (ADLC D0:
  control flow is code, judgment is models).
- Generalize antigravity-booster's proven scheduler mechanics behind a
  harness-agnostic adapter seam.
- Survive interruption: a killed `fleet run` resumes without re-doing merged
  work (§6.4).

**Non-goals (v1)**

- Non-Claude-Code adapters, per-model quota pools, the multi-candidate
  `consensus-fix` fix fan-out (v1's fix loop is single-candidate regeneration),
  GUI/status dashboards, cross-repo fleets, remote/CI execution. Each is a
  follow-on ticket (§14). (A blocking single-pass cross-model prosecution IS in
  v1 — see decision §0.5.)

## 2. Evaluation: what booster proved, what is agy-specific, what generalizes

**Proved by booster (adopt):** event-driven readiness (a ticket dispatches the
moment its edge predecessors merge — no wave barriers); worktree-per-ticket with
sequential rebase-first merges; deterministic gates run twice (in-worktree and
post-merge, failed post-merge = revert); two-strike regeneration informed by
`adlc flail-detector` (a diagnosed flail skips the second strike); charters as
goal + constraints + stop condition, no personas; untrusted-content fencing for
failure logs and diffs (prompt-injection defense); a repo-level lock so exactly
one orchestrator runs; dirty-tree refusal at startup.

**agy-specific (do not port):** per-model quota pools and probed caps
(`pools.mjs`), agy model-name tier tables, the ~5-minute print-mode ceiling,
`plan.json` as a separate plan format, macOS Seatbelt gate sandboxing.

**Generalizes with change:** the plan source becomes `.adlc/tickets.json` itself
(§3); the worker invocation becomes the `WorkerAdapter` interface (§4); pools
collapse to a single semaphore whose abstraction is specified now so pools can
return later (§10).

## 3. Plan source and schema

- The plan is `.adlc/tickets.json`, loaded via `@adlc/core` (`loadTickets`,
  `validateTicket`, `topoSort`, `computeFloat`, `scopesOverlap`, `globMatch`).
  **No new plan format.** Fleet-specific settings live in `.adlc/config.json`
  under a `fleet` key (§7.1) — never in tickets.
- The fleet is a new backlog consumer, so it MUST exclude tickets with
  `completed: true` from its active set (repo invariant #104). Completed tickets
  still satisfy edges: an edge predecessor that is `completed: true` counts as
  merged.
- Edge direction is prerequisite → dependent (an edge `{to: "TX"}` on T0 means
  T0 must merge before TX dispatches).
- `--tickets T…,T…` restricts the run to a subset; a subset member whose
  predecessor is neither in the subset, merged, nor `completed:true` is reported
  BLOCKED, never silently dispatched.

**Readiness invariant.** A ticket is *ready* iff: not `completed:true`, not
already merged/failed this run, every edge predecessor is merged or
`completed:true`, its scope does not overlap (per `scopesOverlap`) any in-flight
ticket's scope, and a concurrency slot is free. Scope-overlapping tickets are
serialized, never concurrent — merge conflicts are scheduled, not resolved
(ADLC D2).

**Single writer per partition.** At most one worker holds a given scope at a
time; workers never write the main checkout; only the orchestrator commits,
merges, and writes `.adlc/` state.

## 4. The WorkerAdapter interface

The scheduler is harness-blind. An adapter is a module exporting:

```js
export const name = 'claude-code';        // adapter id, recorded in status
export const pool = 'default';            // pool this adapter draws from (§10)

// Optional: prepare the worktree before dispatch (write settings/charter files).
export async function provision({ worktree, ticket, charter, config }) {}

// Required: run one build attempt to completion. MUST enforce `timeoutMs`
// itself and MUST NOT write outside `worktree`. Returns collected output.
export async function dispatch({ worktree, prompt, timeoutMs, env, config })
  // -> { exitCode, output, timedOut }
```

- `env` always carries `ADLC_P4_ENFORCEMENT=1` and `ADLC_TICKET=<id>` (§8.2).
- The prompt is the full builder charter (§5); adapters for harnesses that read
  charter files (agy's AGENTS.md) use `provision` — the scheduler does not care.
- Adapters are pure I/O shims: no retry logic, no gate logic, no git. All of
  that is scheduler policy, so future adapters inherit it unchanged.

**v1 `claude-code` adapter.** `provision` writes
`<worktree>/.claude/settings.local.json` containing the permission allowlist
derived from config (§7.2). `dispatch` spawns
`claude -p <prompt> --permission-mode acceptEdits --output-format text` with
`cwd = worktree`, kills the process group on timeout, and maps spawn failure /
non-zero exit / timeout into `{exitCode, timedOut}`. Per the two-plane split
(§7.3, K2), the worker process runs on the **model plane** — network egress plus
its own auth, so it can reach its backend — while the sandboxed **repo-command
plane** (init + gate/test commands, orchestrator-run) is what contains the heavy
arbitrary-code surface. The adapter must NOT be wrapped in the **no-network**
repo-command sandbox, or dispatch could never authenticate; since #395 it IS
wrapped in the model-plane profile, which keeps egress open and bounds writes.

## 5. Charters

Adopted from booster's `charters.mjs`, generalized:

- **Builder charter** = ticket id/title/body + hard constraints (touch only
  `scope`; never edit `rails`; minimal diffs; no new dependencies unless the
  ticket names them; do not commit — the orchestrator commits) + definition of
  done (the gate commands) + a required final line `TICKET-DONE` or
  `TICKET-BLOCKED: <reason>`.
- **Regeneration charter** (strike 2) = builder charter + the prior failure
  diagnostics wrapped in an unguessable fence
  (`<<UNTRUSTED:PRIOR_FAILURE:<uuid>>> … <<END:…>>`) and declared inert data —
  gate logs are attacker-influencable and must never be appended raw.
- No personas; goal + constraints + stop condition only (ADLC P4).

## 6. Scheduler: state machine, persistence, resumability

### 6.1 States

```
pending → building → gating → prosecuting → merging → merged
              ↑          |          |            |
              └── fixing ←┘ (strike) └────────────→ failed | blocked
```

- `building`: adapter dispatch in flight in the ticket's worktree.
- `gating`: the configured build/test command runs in the worktree, then
  `adlc rails-guard --base <base> --ticket <id>` and the scope check (§8.3).
- `prosecuting`: a real, blocking cross-model `adversarial-review` pass (§8.4);
  blocking findings route the ticket to `fixing` (a fix strike), not to `merging`.
- `merging`: sequential rebase-first merge into the `fleet/run-<runId>`
  integration branch + post-merge gate on that branch (§9).
- `blocked`: worker emitted `TICKET-BLOCKED`, or a subset run excluded an
  unmerged predecessor. Blocked consumes no further strikes.
- Dispatch is event-driven: every merge completion recomputes the ready set.

### 6.2 Persistence

`.adlc/fleet-status.json` (in the evidence-ignore/gitignore set, like the other
`.adlc/*` runtime state): `{ runId, base, baseSha, integrationBranch,
sandboxMode, concurrency, startedAt, tickets: { <id>: { state, strikes, branch,
worktree, startSha, adapter, lastExit, updatedAt } } }`. `baseSha` +
`integrationBranch` anchor resume reconciliation (§6.4, N2); per-ticket `startSha`
is the integration tip the ticket was cut from, used as the diff base for the
scope/prosecution gates (§8.3, N3). Written atomically (temp file + rename) after
every transition.

**Read-only observation surface.** The file carries a top-level `schemaVersion`
(`FLEET_STATUS_SCHEMA_VERSION`, currently `1`) so it can be read by external
**observers** — notably the herdr plugin's fleet bridge — not only fleet itself.
The observed fields are `schemaVersion`, `runId`, `integrationBranch`, `baseSha`,
and `tickets` (a map of ticket id → at least `{ state }`, where `state` is one of
`building`, `gating`, `prosecuting`, `fixing`, `merging`, `merged`, `failed`,
`blocked`). Fleet still **owns** the file (it remains gitignored/evidence-ignored
and writers may extend per-ticket records); observers must treat it as read-only and, on an **unknown or absent
`schemaVersion`**, degrade to polling `fleet status --json` rather than trust an
unversioned shape. `schemaVersion` is bumped only on a breaking change to the
fields above.

### 6.3 Worktree lifecycle

- **Create**: `.worktrees/fleet-<id>/` on branch `fleet/<id>` cut from the
  **current integration-branch tip** (recorded as the ticket's `startSha`, §6.2;
  leftover branch/worktree from a prior run is removed first). `.worktrees/`
  is ensured gitignored.
- **Initialize** (orchestrator-run, before dispatch — premortem F3): the
  configured `fleet.init` command (e.g. `npm install`) runs in the worktree
  **through the same `Sandbox` abstraction and scrubbed env as dispatch and gate
  commands (adversarial-review M1)** — `fleet.init` is repo-config-controlled and
  `npm install` executes package lifecycle scripts, so an un-sandboxed init would
  be a host-side arbitrary-code path that bypasses the §7.3 boundary before any
  worker runs. Init failure is operational (exit 1), not a strike. Worktrees do
  not share install artifacts; skipping this fails every ticket's first gate
  command.
- **Reset between strikes** (premortem F4): before a regeneration attempt the
  worktree is restored to clean base state (`git checkout -- . && git clean -fd`)
  — a timed-out worker leaves half-made edits and strike 2 must not build on
  corrupt state. Every file on the **protected-control manifest** (§8.3(d)) is
  **deleted and re-provisioned from template** (not preserved), closing the
  poisoned-ignored-file path (adversarial-review F1); only the explicit inert-path
  allowlist (`.adlc/fleet-logs/**`) carries over.
- **Commit** (premortem F2): the orchestrator commits worker changes with an
  explicit pathspec that excludes fleet-provisioned paths
  (`git add -A -- ':!.claude' ':!.adlc'`), and `provision` ensures its files are
  git-ignored in the worktree. Otherwise `.claude/settings.local.json` enters
  the diff, fails the §8.3 scope check, and every ticket fails deterministically.
- **Cleanup**: merged/failed worktrees are removed and pruned at run end
  (`git worktree remove` + `prune`); failed ticket branches are kept for
  inspection until the next run of the same ticket.

### 6.4 Resumability

**Git is the source of truth; the status file is a cache — but "merged" resolves
against the integration branch, not base (adversarial-review N2).** Because
successful work merges only into `fleet/run-<runId>` and base is never written
(§9), the resume reconciliation MUST use the recorded run anchors, not base. The
status file persists `{ runId, integrationBranch, baseSha, ... }` (§6.2); on
startup for the *same recorded run*, a ticket whose branch is an ancestor of the
recorded `integrationBranch` (`git merge-base --is-ancestor <ticketBranch>
<integrationBranch>`) is `merged`; a ticket with a live worktree but no in-flight
process is reset to `pending` (its strikes counter preserved); stale
worktrees/branches from dead runs are pruned, and any in-progress git operation
left by a dead run (`rebase`, `merge`) is aborted before reconciliation
(premortem F4). If the recorded `integrationBranch` is missing/deleted or
`baseSha` has moved out from under the run, resume refuses and asks for a fresh
run rather than guessing. A resumed run never re-dispatches a merged ticket.

**Lock ownership and stale recovery (adversarial-review F5 + N5).** The repo lock
is an atomic `mkdir .adlc/fleet.lock`, but "always released" only holds on a
clean exit — a SIGKILL or crash leaves it behind, which would make the *next* run
refuse to start and defeat the resumability promise. So the lock is not a bare
directory: on acquire the orchestrator writes `.adlc/fleet.lock/owner.json`
(`{pid, host, runId, startedAt, procStartTime}`). On encountering an existing
lock, `fleet run` checks ownership: the lock is considered *live* only if a
process with the recorded `pid` exists on the same `host` **and its process
start-time matches the recorded `procStartTime`** — PIDs are reused, so
PID-liveness alone would misclassify a stale lock as live (N5); matching the
start-time (from `/proc/<pid>` on Linux or `ps -o lstart` equivalent, with a
boot-id fallback) defeats reuse. A non-live lock is stale and reclaimed before
reconciliation; a live lock makes the run refuse (a real concurrent instance). A
guarded `fleet unlock` remains a fallback for cross-host or ambiguous cases, not
the normal path. Only then does `fleet run` also refuse on a dirty main checkout.

## 7. Configuration and worker permissions

### 7.1 `.adlc/config.json` → `fleet` key

```json
{
  "fleet": {
    "gate": { "build": "npm run build --workspaces --if-present", "test": "npm test" },
    "init": "npm install",
    "concurrency": 2,
    "base": "main",
    "timeoutMinutes": 30,
    "allowedCommands": ["npm test", "npm run build:*", "node --test *"]
  }
}
```

CLI flags (`--concurrency`, `--base`, `--tickets`, `--dry-run`) override config.
Missing `fleet.gate` is an operational error (exit 1): an ungated fleet must not
run.

### 7.2 Worker permission model (user decision)

- `claude -p --permission-mode acceptEdits`: file edits auto-approve (contained
  by scope/rails enforcement, §8), everything else needs an allowlist entry. In
  headless mode a non-allowlisted tool call is *denied*, not prompted.
- `provision` writes `<worktree>/.claude/settings.local.json` whose
  `permissions.allow` contains exactly: the configured gate commands, the
  configured `allowedCommands`, and read-only git commands (`git status`,
  `git diff*`, `git log*`). Nothing else. No network tools, no `git commit`
  (the orchestrator commits), no package installs unless explicitly allowlisted.
- **Rule syntax is load-bearing (premortem F1)**: config strings are translated
  into Claude Code permission-rule form (`"npm run build:*"` →
  `Bash(npm run build:*)`) by one tested function. Raw strings would allowlist
  nothing and deny every gate command, failing the whole plan two strikes at a
  time. A **preflight canary** (§8.0) proves the plumbing before any real
  dispatch.
- **Config surface (premortem F5)**: workers inherit the user's global Claude
  config — plugins, MCP servers, hooks. v1 constrains the surface at dispatch
  (e.g. `--strict-mcp-config` / an explicit tool disallow list for MCP and
  network tools, per the flags available in the installed CLI, pinned in ADR
  0010) so an unattended worker cannot reach mail/calendar/network tools that
  happen to be connected interactively.
- **Scrubbed environment (adversarial-review F2, split per K2)**: allowlisted
  gate commands (`npm test`, etc.) execute arbitrary code *by design*, so their
  env is scrubbed the hardest. Per the two planes (§7.3):
  - *Repo-command plane* (init, build, test, gate — orchestrator-run): env
    **scrubbed to an allowlist** — only `PATH`, `ADLC_*`, and config-named keys;
    `HOME` set to the **synthetic in-worktree home**; ALL provider keys and cloud
    creds (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `*_TOKEN`, `*_SECRET`) stripped;
    network denied and reads/writes worktree-bounded by the sandbox (§7.3).
  - *Model plane* (the `claude -p` worker): env carries `PATH`, the real `HOME`,
    and **only** the worker's own model auth (its subscription/session, or a
    single injected model key); unrelated host creds and cloud secrets are still
    stripped. Since #395 **no ambient `ADLC_*` variable is inherited** either —
    those name the operator's trust roots (the quartermaster registry, the ticket
    store, the rails bypass) and the worker runs candidate-authored gate commands;
    what the charter needs (`ADLC_TICKET`, `ADLC_P4_ENFORCEMENT`) is injected
    explicitly. The worker keeps just enough to reach its model, nothing more.
  This bounds credential exfiltration on both planes; full network/read/write
  containment of arbitrary repo-command code comes from the required OS sandbox
  (§7.3).
- A worker that needs a non-allowlisted command cannot proceed; the attempt
  fails its strike with the denial visible in the log — by design.
- Defense of the allowlist itself: `.claude/**` and `.adlc/**` are appended to
  the *effective* rail set of every dispatched ticket at runtime (never written
  back to `tickets.json`), so the in-session hook denies a worker editing its
  own permissions. **The diff-based scope check alone is insufficient here
  (adversarial-review F1)**: these paths are gitignored in the worktree, so a
  Bash-spelled write to `.claude/settings.local.json` or `.adlc/fleet-status.json`
  never appears in `git diff --name-only` and would slip the tracked-diff gate.
  The deterministic backstop for *ignored* protected paths is therefore an
  explicit integrity scan, not the diff: before commit, the orchestrator
  (a) enumerates every file under `.claude/**` and `.adlc/**` in the worktree
  including ignored/untracked ones (`git ls-files --others --ignored --exclude-standard`
  plus the tracked set) and (b) byte-compares each against the orchestrator-owned
  template it provisioned; any orchestrator-owned control file that a worker
  created or modified fails the attempt (§8.3(d)). Between strikes these files are
  **deleted and re-provisioned from template, never preserved** (§6.3), so a
  poisoned control file cannot survive into a retry.

### 7.3 Sandbox model (user decision — closes adversarial-review F2)

**Two distinct planes (adversarial-review K2).** The containment boundary is not
"sandbox everything" — the Claude Code worker must reach its model provider to
function, so wrapping the worker process in a no-network, credential-stripped
sandbox would make every build fail before gates matter. The spec therefore
separates:

- **Repo-command plane** — the repo-configured `init` command, every build/test/
  gate command (all orchestrator-invoked, §8.3), and the worker's tool-subprocess
  Bash where the harness supports interposition. This is where arbitrary code runs
  (`npm install` lifecycle scripts, test suites), so **this plane runs inside the
  OS sandbox** below.
- **Model plane** — the worker process (`claude -p`) itself. It runs with
  **network egress** (today: open; the narrower provider-endpoint allowlist is
  still the goal) and access to *its own* auth (subscription/session in
  `~/.claude`, or an injected model key), but **not** to unrelated host
  credentials (`~/.ssh`, `~/.aws`, cloud creds), which are withheld from the
  worker env. The worker's *file* actions stay bounded by acceptEdits +
  scope/rails (§7.2, §8) **and, since issue #395, by an OS sandbox of its own**.

**Network isolation and filesystem isolation are independent axes (#395).** K2's
argument is that a worker which cannot reach its provider cannot function. That
argument is about the NETWORK, and the original implementation over-applied it:
the worker was not wrapped at all, which also gave up a filesystem bound it never
needed to give up. The consequence was concrete rather than theoretical — the
worker's permission allowlist contains repo-authored `fleet.gate` commands (§7.2
builds them from the CANDIDATE tree's `.adlc/config.json`) and the builder charter
instructs the worker to run them, so candidate-authored code executed with the
operator's filesystem privileges, able to rewrite the operator-local quartermaster
registry, `~/.claude` settings and hooks, the installed toolkit, or another repo's
worktree.

Both planes are therefore sandboxed; they differ on ONE axis:

| | repo-command plane | model plane |
| --- | --- | --- |
| network | **denied** | **allowed** (K2) |
| writes | worktree + synthetic HOME | worktree + the harness's declared state dirs |
| reads | bounded (worktree + read-only runtime allowlist) | host scope — **documented residual** |
| HOME | synthetic, in-worktree | the operator's real HOME (its own session auth lives there) |

- **The write grant is adapter-owned and fail-closed.** Each `WorkerAdapter`
  declares `homeState` — the directories and files its harness writes under
  `HOME` — the same way it declares `aliases` and `transports`. Only leaf STATE
  directories are declared, never the harness's config directory: `~/.claude/projects`
  is session scratch, while `~/.claude` holds `settings.json` and `hooks/`, which
  decide what runs in the operator's NEXT session. An adapter that declares
  nothing gets nothing outside the worktree, so an unlisted path surfaces as that
  harness erroring loudly rather than as a hole that reopens silently. The
  operator-local `--model-plane-writable <path>` widens it; a repo-committed
  `fleet.modelPlaneWritable` is ignored with a warning (same rule as N1).
- **The worker is not told where operator-local state lives.** `modelPlaneEnv`
  passes NO ambient `ADLC_*` variable (`ADLC_QUARTERMASTER_REGISTRY`,
  `ADLC_TICKET_STORE`, `ADLC_RAILS_BYPASS`, …); what the charter needs is injected
  explicitly. It is an allow-list, so an `ADLC_*` variable added later is withheld
  by construction rather than by remembering to add it to a denylist.
- **Residual: model-plane READS are unbounded**, and egress is open, so
  read-and-exfiltrate remains possible. Bounding them means enumerating where each
  harness keeps auth on each platform — a macOS Keychain item is not a file — and
  is deliberately out of scope. Running a fleet over an untrusted repo remains
  outside this design's assumptions.
- **No new fail-closed decision.** The model plane reuses the run-wide sandbox
  mode below: a host with no backend already refuses to dispatch, and
  `--i-am-in-a-disposable-container` already asserts the whole run is contained.
  There is no model-plane-only opt-out to reason about.

The heavy arbitrary-code surface (tests, installs) is still on the repo-command
plane, run by the orchestrator, not by the worker:

Because an allowlisted test command (and a repo-configured `npm install`)
executes arbitrary code, **the repo-command plane runs inside an OS sandbox**
(adversarial-review M1), not the bare host:

- **Isolation goal**: network egress denied by default; filesystem **writes**
  bounded to the ticket's worktree (+ the OS temp dir); filesystem **reads**
  bounded to the worktree plus an explicit read-only allowlist of runtime/tool
  paths (the interpreter, the package cache) — the operator's real home and
  credential directories (`~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.claude`, `~/.codex`,
  …) are **not mounted/visible** (adversarial-review K1); and the process tree
  reaped on exit. Read isolation matters as much as write bounds: with network
  denied, the realistic exfiltration path is reading a file-backed secret from
  the host home and copying it into an in-scope source file or a log that then
  reaches the integration branch/PR. `HOME` is therefore set to a **synthetic
  directory inside the worktree**, never the operator's real home. A test that
  tries to exfiltrate, to read host credentials, or to write outside the worktree
  is contained, not merely detected after the fact.
- **Mechanism (pinned in ADR 0010, zero-dep)**: a `Sandbox` abstraction with a
  detected backend that provides BOTH network and filesystem isolation — Linux
  `bwrap` (bubblewrap: network namespace + fine-grained worktree binds), macOS
  `sandbox-exec` (Seatbelt profile). Plain `unshare --net` is **deliberately not
  accepted** (adversarial-review C2): it isolates the network but leaves the host
  filesystem visible, which would violate the read/write boundary this module
  promises — an `unshare`-only host reports no backend and fails closed. The
  abstraction is what the scheduler calls; the backend is swappable.
- **Fail closed**: if no sandbox backend is available, `fleet run` refuses to
  dispatch (exit 1). The single escape hatch is the `--i-am-in-a-disposable-container`
  **CLI flag** (or an untracked operator-local user config file); it asserts the
  operator has already isolated the whole run (container with no secrets, no
  network, disposable FS) and downgrades the per-dispatch sandbox to env-scrub
  only. **Repo-committed config cannot disable the sandbox (adversarial-review
  N1)**: the `.adlc/config.json` `fleet` key is a repo-controlled surface, so a
  committed config that tries to set the override is *ignored with a loud warning*
  — only an operator-local flag/user-config can select env-scrub-only mode. The
  status output and logs state loudly which mode is active — sandbox absence is
  never silent (the fail-open-visibility lesson).
- **Layering**: the sandbox is defense-in-depth *under* the permission allowlist
  (§7.2) and the deterministic pre-merge gates (§8.3), not a replacement for
  them.

## 8. Gate integration (which adlc gates run where)

0. **Preflight (before any dispatch)**: (a) repo lock + clean-tree checks
   (§6.4); (b) **canary dispatch** (premortem F1) — a throwaway worktree runs a
   trivial charter whose only task is executing one allowlisted command; if the
   command is denied or the adapter fails, the run aborts operationally (exit 1)
   before burning strikes on real tickets; (c) **rail-hook probe** (premortem
   F5 / the fail-open-visibility lesson) — preflight verifies the adlc plugin's
   PreToolUse rail hook is installed for the worker; if absent it warns loudly
   that in-session enforcement (§8.2) is missing and only the deterministic
   pre-merge gates (§8.3) protect rails. The run may proceed — layer 3 is
   advisory-in-depth — but never silently.
1. **Pre-run, whole plan**: `adlc merge-forecast --json` — recorded into the
   run status; hard-veto pairs are structurally serialized anyway by the
   readiness invariant (§3), so the forecast is evidence, not a second
   enforcement path. Exit 1 aborts the run; exit 0/2 proceed.
2. **In-worker, in-session**: `ADLC_P4_ENFORCEMENT=1` + `ADLC_TICKET=<id>` in
   the worker env arm the plugin's PreToolUse rail hook inside the worktree
   (denies Edit/Write to rails and the frozen trust root).
3. **Pre-merge, deterministic (the backstop — Bash-spelled edits cannot pass)**:
   in the worktree, after the orchestrator commits the worker's changes. **The
   diff base is the ticket's `startSha` (the integration tip it was cut from),
   NOT base (adversarial-review N3)** — using `<base>...HEAD` after the ticket was
   rebased onto the integration branch would fold in *prior* tickets' files and
   fail this ticket's own scope check. So:
   (a) the configured `fleet.gate` commands exit 0;
   (b) `adlc rails-guard --base <startSha> --ticket <id>` exits 0;
   (c) **scope check**: every path in `git diff --name-only <startSha>..HEAD`
   (the ticket-local patch only) must match the ticket's `scope` globs (via
   `@adlc/core` `globMatch`), else the attempt fails. This is fleet's own code,
   not a worker promise;
   (d) **protected-path integrity scan (adversarial-review F1 + N4 + M2)**:
   the diff in (c) only sees *tracked, committed* changes, and the orchestrator's
   commit pathspec deliberately excludes `.claude/` and `.adlc/` (§6.3), so a
   worker's **working-tree** write to a control file — including the tracked
   `.adlc/tickets.json` — never reaches HEAD and would evade (c). Control files
   are therefore checked separately against an **explicit protected-control-file
   manifest**, comparing the live **worktree** copy (tracked-but-unstaged,
   untracked, OR ignored) against the orchestrator-owned template / the committed
   `startSha` version:
   - `.claude/settings.local.json` and any other file `provision` writes;
   - `.adlc/config.json`, `.adlc/fleet-status.json`;
   - **the trust roots `.adlc/tickets.json` and `.adlc/current-ticket.json`
     (adversarial-review M2)** — the plan/rail source; a worker that rewrites its
     worktree copy to drop a rail or widen scope must fail here, *before*
     rails-guard or prosecution read the working tree, exactly as the ADLC plugin
     freezes the trust root in-session.

   Any manifest file whose worktree copy differs from its authoritative version,
   and any *new* non-allowlisted file appearing under `.claude/**` or `.adlc/**`,
   fails the attempt. The scan is a *closed manifest* with a single inert-path
   allowlist (`.adlc/fleet-logs/**`), not a blanket sweep — so legitimate logs do
   not trip it, and a worker cannot introduce a new control file under these
   prefixes without failing. This is what makes the "a worker cannot edit its own
   permissions or the plan via Bash" claim true.
4. **Prosecution — blocking, cross-model (v1, closes adversarial-review F3)**:
   after 3(a-d) pass, `prosecute({worktree, ticket, diff})` runs a real
   `npx adversarial-review --base <startSha> --json` pass over the **ticket-local**
   diff (`<startSha>..HEAD`, per N3 — never the cumulative integration diff). Requirements: (i) it runs in a **fresh context** and, per
   `adversarial-review`'s own provider selection, prefers a **different provider
   than built the ticket** (the cross-model value this repo has measured); (ii)
   the deterministic gate — exit `2`/any finding at/above the configured
   `fleet.prosecuteFailOn` severity (default `medium`) — routes the ticket to
   `fixing`, **not** `merging`; (iii) the fix strike appends the findings to the
   fix charter inside an UNTRUSTED fence (§5) — verdict text from the review is
   data, and the ticket re-runs the whole gate chain, never merging on the
   review's say-so; (iv) if no review provider is reachable, prosecution
   **fails closed** (the ticket does not merge; the run surfaces the missing
   provider) — a fleet that cannot prosecute must not auto-merge. The
   multi-candidate `adlc consensus-fix` fan-out is the follow-on enhancement
   (§14); v1's fix loop is single-candidate regeneration under the two-strike cap.
5. **Evidence**: each gate outcome (forecast, build/test, rails-guard, scope
   check, integrity scan, prosecution verdict, merge, post-merge) is appended to
   `fleet-status.json`; where `adlc gate-manifest record` is available, the fleet
   records the P4 and P5 gate results per ticket so `adlc run p4/p5 --ticket <id>`
   can assert them later.

## 9. Merge policy — integration branch (user decision, mitigates adversarial-review F3)

- **The fleet never writes base.** At run start it creates a per-run integration
  branch `fleet/run-<runId>` from the current base SHA. Every finished ticket
  merges into that branch; base (`main`) is untouched by the fleet.
- Merges into the integration branch are **strictly sequential** (a merge lock
  in-process); builds/gates may overlap, merges never do. The post-merge gate on
  the integration branch runs with no other gate running.
- Readiness edges resolve against **integration-branch** state, not base: an edge
  predecessor is "merged" once it is an ancestor of `fleet/run-<runId>` (or is
  `completed:true`).
- Order: rebase the ticket branch onto the current integration-branch tip
  (rebase-first); on rebase conflict the ticket fails its strike (conflicts were
  scheduled away by scope serialization — one appearing means the plan lied, a
  signal not to auto-fix).
- After merge into the integration branch: run the post-merge gate on it.
  Failure ⇒ revert the merge. **Reset is not blind (adversarial-review F4)**:
  another local process could commit to the integration branch during a long
  post-merge gate, and a blind `reset --hard <pre-merge-sha>` would silently drop
  that work. So before reverting, the orchestrator asserts the integration branch
  HEAD is *exactly* the merge commit it just created; if it still is, it resets
  to the recorded pre-merge SHA; if HEAD has moved, the fleet does **not** reset —
  it stops and surfaces a manual-recovery message (or falls back to
  `git revert <merge-sha>`, safe under a moved HEAD). Either way the ticket's
  strike is consumed.
- **Run end**: the fleet does not push and does not merge to base. It leaves
  `fleet/run-<runId>` for review and, when the `gh` CLI is available and
  configured, opens **one** PR from that branch to base. The human review of that
  single branch/PR (ADLC P6) is the final gate before anything reaches base —
  now backed by the per-ticket blocking prosecution (§8.4), so it is review of
  already-prosecuted work, not the sole adversarial gate.

## 10. Concurrency model

- v1: one pool, `default`, cap = `fleet.concurrency` (default 2). The scheduler
  acquires a slot from the adapter's declared pool before dispatch.
- The pool abstraction is `{ name, cap, inFlight }` with `acquire/release` —
  specified now so per-model quota pools (booster's `PoolSet`) can return as
  multiple pools without scheduler changes. Pool caps come from config;
  the scheduler never hardcodes them.

## 11. Observability

- `fleet run` streams one narrated line per transition
  (`T7 building → gating (strike 1)`), plus a summary table at exit.
- `fleet status` pretty-prints `fleet-status.json` (per-ticket state, strikes,
  worktree, last gate output tail) and exits 0.
- `fleet run --dry-run` prints the computed ready set, dispatch order, and
  scope-serialization decisions **without** creating worktrees or spawning
  workers, and exits 0.
- Worker output is appended per-ticket to `.adlc/fleet-logs/<id>.log`
  (gitignored); flail-detector reads the accumulated log across strikes.

## 12. Failure policy

- **Two strikes** per ticket: after a failed attempt, run
  `adlc flail-detector .adlc/fleet-logs/<id>.log --scope <glob…> --json`.
  A diagnosed flail skips the second strike (regenerating from the same dead
  end is waste); a clean one-off failure retries once with the fenced failure
  context appended (§5). Flail-detector errors fail OPEN — an unverifiable
  signal must not cut a build's normal retry short; the two-strike cap is the
  backstop.
- `TICKET-BLOCKED` from the worker marks the ticket `blocked` without consuming
  the second strike (the ticket is wrong, not the agent — ADLC P4).
- A failed/blocked ticket blocks its dependents (they are reported, not
  dispatched); independent tickets continue.
- Exit codes (CONVENTIONS): `0` = every dispatched ticket merged; `2` = at
  least one ticket failed/blocked; `1` = operational error (bad config, dirty
  tree, lock held, missing gate).

## 13. Threat model

A fleet of unattended writers is a new blast-radius surface. Containment layers,
in order:

1. **Worktree isolation** — workers never touch the main checkout; the
   orchestrator alone commits/merges. A destroyed worktree costs one strike.
2. **OS sandbox on both planes** (§7.3, K2 split; completed by #395) — the init,
   build, test, and gate commands (the arbitrary-code surface: test suites,
   `npm install` lifecycle scripts) run network-denied with filesystem **writes
   and reads** bounded to the worktree (synthetic HOME, host credential dirs
   unmounted); the fleet fails closed if no sandbox is available (F2/M1/K1). The
   `claude -p` worker runs on the separate model plane, which keeps egress and its
   own auth so it can function, and bounds its **writes** to the worktree plus its
   harness's declared state directories — closing the path by which a repo-authored
   `fleet.gate` command, run by the worker on the charter's instruction, could
   rewrite operator-local state. Model-plane READS stay at host scope: a documented
   residual, not a claim.
3. **Permission allowlist** (§7.2) — workers cannot run arbitrary shell, install
   packages, push, or use the network unless explicitly allowlisted per repo.
4. **Rails + trust root, in-session** — the plugin hook denies structured edits
   to rails, `.adlc/tickets.json`, and (via the runtime rail append) `.claude/**`
   + `.adlc/**`, so a worker cannot widen its own permissions or rewrite the
   plan.
5. **Deterministic pre-merge diff gates** (§8.3) — rails-guard + the scope check
   + the ignored-path integrity scan catch anything spelled via Bash that the
   in-session hook cannot parse. Nothing merges on a worker's say-so.
6. **Blocking cross-model prosecution** (§8.4) — a fresh-context, preferably
   cross-provider `adversarial-review` pass must clear each ticket before merge;
   it fails closed if no review provider is reachable. This is the adversarial
   gate on *in-scope but unsafe* behavior (adversarial-review F3).
7. **Integration branch, never base** (§9) — the fleet writes only
   `fleet/run-<runId>` and opens a single PR; base is reached only through the
   human P6 review of already-prosecuted work.
8. **Prompt-injection fencing** — gate logs, diffs, prior-failure context, and
   prosecution findings are attacker-influencable; they enter charters only
   inside unguessable UNTRUSTED fences (§5). Verdict-bearing text (`TICKET-DONE`,
   a review verdict) is never trusted: gates re-verify everything.
9. **Resource bounds** — per-attempt timeout (config), the concurrency cap, the
   two-strike cap, and the single-instance repo lock bound runaway cost.

**Residual risks in v1 (reduced by the §0.5–0.7 hardening, stated honestly):**

- *Env-scrub completeness (F2 tail).* The sandbox denies network by default and
  bounds filesystem reads and writes (synthetic HOME, host credential dirs
  unmounted — K1), so exfiltration and out-of-worktree access are contained even
  if the env-scrub allowlist (§7.2) misses a secret. The residual is a
  misconfigured `--i-am-in-a-disposable-container` override that claims isolation
  the container does not actually provide — an operator error the mode's loud
  logging is designed to make obvious, not silent.
- *Prosecution model fallibility (F3 tail).* Prosecution is now a blocking gate,
  but a cross-model reviewer can still miss a subtle in-scope defect. The
  integration-branch + single-PR human review (§9) remains the final backstop;
  the fleet still never pushes to base autonomously.

## 14. Out of scope → follow-on tickets

Codex/agy/opencode/pi/cursor adapters; per-model quota pools (multi-pool
config); the multi-candidate `adlc consensus-fix` fix fan-out (v1 has a blocking
prosecution gate but a single-candidate fix loop); additional sandbox backends
beyond the one the host provides; status dashboards; cross-repo fleets; CI/remote
execution of `fleet run`. (In v1 and no longer out of scope: the blocking
cross-model prosecution gate §8.4, the OS sandbox §7.3, and the integration-branch
merge policy §9.)

## 15. Acceptance criteria

Mirrors ticket T42; each criterion is independently verifiable.

- AC1 (spec gated): this file passes `adlc spec-lint docs/specs/fleet-orchestration.md`
  (exit 0), premortem findings are folded in, and the Approval line is filled
  before any `packages/fleet` code is committed. VERIFY: run spec-lint; `git log
  --oneline -- docs/specs/fleet-orchestration.md packages/fleet` shows the spec
  commit first.
- AC2 (conventions): `packages/fleet/package.json` declares **no third-party
  runtime dependencies** — its only `dependencies` entry is the in-repo workspace
  sibling `@adlc/core` (the repo's actual "zero runtime dependencies" meaning:
  nothing outside `@adlc/core`, which all 22 packages import via the `@adlc/core`
  specifier under the npm workspace, NOT a relative path — CONVENTIONS.md's
  literal "relative path" text is stale and followed by 0 of 22 packages) —
  plus `type: module`, `engines.node >= 18`, and a `fleet` bin. VERIFY: inspect
  `packages/fleet/package.json`; assert `dependencies` contains only `@adlc/core`
  and no third-party package.
- AC3 (scheduler correctness, offline): `npm test` in `packages/fleet` passes
  offline with a stubbed WorkerAdapter and stubbed git/gates, covering: (a)
  dispatch only after all edge predecessors merge; (b) `completed:true` never
  dispatched but satisfies edges; (c) concurrency cap never exceeded; (d)
  scope-overlapping tickets never concurrent; (e) two-strike semantics; (f)
  diagnosed flail skips strike 2; (g) failed post-merge gate reverts; (h) a
  killed run resumes without re-dispatching merged tickets; (i) a ticket with
  blocking prosecution findings (stubbed review verdict) routes to `fixing`, not
  `merging`, and only merges after a clean re-prosecution. VERIFY: run
  `npm test` in packages/fleet; read test/scheduler.test.mjs for cases a–i
  exercising the real scheduler.
- AC4 (adapter, offline): `node --test packages/fleet/test/adapter-claude-code.test.mjs`
  passes; it injects an exec stub and
  asserts argv contains `-p` and `--permission-mode acceptEdits`, cwd is the
  worktree, env carries `ADLC_P4_ENFORCEMENT=1` + `ADLC_TICKET`, provision
  writes only the allowlist settings file, and timeout maps to a failed strike.
- AC5 (live smoke): `node packages/fleet/bin/fleet.mjs run --dry-run` against
  this repo's real `.adlc/tickets.json` exits 0, prints the ready set +
  dispatch plan, lists only incomplete tickets with satisfied edges, and
  creates no worktrees. VERIFY: run it; `git worktree list` unchanged.
- AC6 (no regression): repo root `npm test` stays green and
  `git diff --name-only main...HEAD` is a subset of T42's scope. VERIFY: run
  both commands.
- AC7 (ADR): `docs/adr/0010-adlc-fleet-orchestration.md` pins the §0 decisions
  with a `## Threat Model` section. VERIFY:
  `grep -l "WorkerAdapter" docs/adr/0010-adlc-fleet-orchestration.md` and
  `grep -c "## Threat Model" docs/adr/0010-adlc-fleet-orchestration.md` ≥ 1.
- AC8 (protected-path integrity, adversarial-review F1 + N4): `node --test packages/fleet/test/protected-paths.test.mjs`
  passes — it (i) writes a manifest control file (`.claude/settings.local.json`
  or `.adlc/fleet-status.json`) inside a stub worktree that does NOT appear in
  `git diff --name-only` and asserts the integrity scan (§8.3(d)) fails the
  attempt anyway; (ii) writes a normal `.adlc/fleet-logs/T1.log` and asserts the
  scan does NOT fail it (closed manifest, not a blanket `.adlc/**` sweep); (iii)
  writes a NEW unexpected control file under a protected prefix and asserts it
  fails; (iv) modifies the tracked `.adlc/tickets.json` in the worktree only
  (unstaged, absent from `git diff <startSha>..HEAD`) and asserts the scan fails
  the attempt before any gate reads it (M2 trust-root).
- AC9 (revert safety, adversarial-review F4): `node --test packages/fleet/test/revert-safety.test.mjs`
  passes — it simulates base HEAD moving during the post-merge gate and asserts
  the orchestrator refuses the blind reset (does not drop the moved-in commit)
  and takes the manual-recovery / `git revert` path instead.
- AC10 (stale-lock recovery, adversarial-review F5 + N5): `node --test packages/fleet/test/lock-recovery.test.mjs`
  passes — it (i) leaves a `.adlc/fleet.lock/owner.json` naming a dead pid and
  asserts `fleet run` reclaims it; (ii) leaves a live pid whose recorded
  `procStartTime` does NOT match the running process (PID reuse) and asserts the
  lock is treated as stale and reclaimed; (iii) leaves a genuinely live matching
  lock and asserts the run refuses.
- AC11 (env scrub, adversarial-review F2): `node --test packages/fleet/test/env-scrub.test.mjs`
  passes — it asserts the env passed to both worker `dispatch` and gate commands
  excludes `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `*_SECRET` / `*_TOKEN` while
  retaining `PATH`, `HOME`, and `ADLC_*`.
- AC12 (blocking prosecution, §0.5 / F3): `node --test packages/fleet/test/prosecution-gate.test.mjs`
  passes — with a stubbed `adversarial-review` runner it asserts (i) a blocking
  finding routes the ticket to `fixing` and it does NOT merge; (ii) a clean pass
  lets it proceed to `merging`; (iii) an unreachable review provider fails closed
  (no merge). No live model call in the test.
- AC13 (integration branch + resume/diff anchors, §0.6 / F3 / N2 / N3): `node --test packages/fleet/test/merge-target.test.mjs`
  passes — with stubbed git it asserts (i) merges land on `fleet/run-<runId>`,
  base (`main`) is never written, edge readiness resolves against the integration
  branch, and run-end opens at most one PR; (ii) resume classifies a ticket as
  `merged` by ancestry to the recorded `integrationBranch` (NOT base), so a crash
  before PR-merge does not re-dispatch integrated work (N2); (iii) a ticket's
  scope/prosecution diff base is its `startSha`, so a ticket rebased over a prior
  ticket does not fail its own scope check on the prior ticket's files (N3).
  VERIFY additionally: `fleet run --dry-run` reports the integration branch name
  and `git rev-parse main` is unchanged after a stubbed run.
- AC14 (sandbox fail-closed, §0.7 / F2 / N1): `node --test packages/fleet/test/sandbox.test.mjs`
  passes — it asserts (i) `fleet run` refuses to dispatch (exit 1) when no sandbox
  backend is detected and the disposable-container override is absent; (ii) the
  operator-local CLI flag downgrades to env-scrub-only while logging the active
  mode; (iii) a repo-committed `.adlc/config.json` attempting to set the override
  is IGNORED with a warning and the run still fails closed (N1 — repo config
  cannot disable the sandbox); (iv) the repo-configured `fleet.init` command is
  dispatched through the `Sandbox` abstraction with scrubbed env, not the bare
  host (M1) — asserted by a stubbed sandbox recording that `init` was routed
  through it; (v) a gate/init command that tries to read a planted secret from a
  path outside the worktree (a fake `$HOME/.aws/credentials` on the real host
  home) is blocked by the sandbox's read isolation (K1) — asserted via the
  stubbed sandbox's read-boundary enforcement; (vi) the two-plane split (K2) is
  enforced — a stub asserts the `claude -p` worker is dispatched on the model
  plane (egress + own auth reachable, NOT wrapped in the no-network repo-command
  sandbox) while init/gate/test commands ARE routed through the sandbox, so a
  valid ticket can both authenticate and stay contained.
- AC15 (model-plane containment, §7.3 / issue #395):
  `node --test packages/fleet/test/model-plane-sandbox.test.mjs` passes — it
  asserts (i) a repo-controlled command run through the REAL model-plane profile
  cannot overwrite an operator-local quartermaster registry outside the worktree,
  with an UNWRAPPED control proving the same write succeeds without the sandbox;
  (ii) the same for a `$HOME/.claude/settings.json`, while the harness's declared
  `.claude/projects` state stays writable; (iii) the model-plane env carries no
  operator-local registry path, and the withholding is an allow-list over a named
  set, so a sibling variable added later is withheld by construction; (iv) the
  model-plane profile preserves network egress on BOTH backends (no
  `--unshare-net`; `(allow network*)`) while the repo-command profile still denies
  it — verified in `sandbox.test.mjs`; (v) no backend and no override still
  refuses the whole run, so the model plane introduces no second fail-closed
  decision and no model-plane-only opt-out. (i)–(ii) require a real backend and
  report a SKIP with its reason where none is detected, never a silent pass.
