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
- **Model plane** — the `claude -p` worker runs with network egress and its own
  auth so it can function, and is wrapped in a *filesystem* sandbox: its **writes**
  are bounded to the ticket's worktree plus the state directories its harness
  declares. Network and filesystem are independent axes; K2 only ever required
  the network one to differ (#395). Reads are not bounded there — a documented
  residual, see the security section.
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
fleet run [--concurrency N] [--tickets T1,T2] [--base main] [--json]
fleet run --tickets T1 --no-pr --no-complete --max-strikes 14 --wall-clock-minutes 60 \
          --pre-strike-argv '["/abs/adlc","autopilot","quota","--json"]' --pre-strike-env '{"PATH":"/usr/bin","HOME":"/home/me"}' \
          --model-plane-read bounded --model-plane-read-only /opt/tools/rg \
          --model-plane-git mirror --model-plane-git-mirror /abs/mirror.git \
          --model-plane-egress allowlist --worker-deps /abs/worker-deps/node_modules --json
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
spawns its harness in headless mode on the **model plane** (network egress + its
own auth, filesystem writes bounded — K2 + #395). Select one with the
**operator-local** `--adapter` flag (default `claude-code`).

Each adapter also declares `egressHosts` — the `host:port` pairs its harness must
reach (the model API and its OAuth hosts). Under `--model-plane-egress
allowlist` those are the ONLY destinations the host-side CONNECT proxy permits;
an adapter that declares none cannot run in allowlist mode (fail closed).

Each adapter also declares `homeState` — the directories and files its harness
writes under `HOME`. That declaration IS the model-plane write grant: an adapter
that declares nothing gets nothing outside the worktree, so a new harness fails
loudly rather than inheriting a blanket grant. If a harness needs a path its
declaration has not caught up with, widen it with the operator-local
`--model-plane-writable <path>` (repeatable); a `fleet.modelPlaneWritable` in
repo config is ignored with a warning, since letting the candidate tree widen the
boundary that contains it would be the boundary disabling itself.

**The harness is operator-local, not repo config (adversarial-review K1/A2):** only
`claude-code` installs a per-worktree permission allowlist, so a repo-committed
`fleet.adapter`/`fleet.adapterCommand` could silently move unattended workers onto a
less-contained harness. Choosing the harness (and any binary override) is therefore an
operator trust decision — set via `--adapter` / `--adapter-command` / `--adapter-args`;
a value in `.adlc/config.json` is ignored with a warning.

**The model and its credential are operator-local too** (operating-stack §4/§10).
`fleet.model` and `fleet.modelAuthKey` in `.adlc/config.json` are now **ignored
with a warning**; use `--model` and `--model-auth-key`.

- `model` used to be treated as "non-executable data", which was safe only by
  accident: `claude-code`, `codex`, and `opencode` all silently dropped it, so it
  reached nothing but the agy adapter. Now that every adapter forces its model
  onto the command line, a repo-committed value would let a candidate tree choose
  the model that builds and judges it.
- `modelAuthKey` is more dangerous still: it names the ONE variable exempted from
  `modelPlaneEnv`'s secret stripping, so a repo value chose which host secret
  entered a code-capable worker. A candidate could name
  `ADLC_MANIFEST_KEY` and read the key that signs cross-model attestations.
  `ADLC_MANIFEST_KEY` is additionally on a hard denylist — no `modelAuthKey`
  unlocks it, not even an operator's.

Only `adapterStdin` (a prompt-transport shape, not a supply or credential choice)
is still read from repo config.

### What the model-plane sandbox does and does not close (#395)

The worker's permission allowlist contains repo-authored `fleet.gate` commands
(they come from the candidate tree's `.adlc/config.json`) and the builder charter
tells the worker to run them. That makes a gate command ordinary candidate code
running on the model plane.

**Closed:** it cannot write outside the ticket worktree. Not the operator-local
quartermaster registry, not `~/.claude/settings.json` or `~/.claude/hooks/`, not
the installed toolkit, not another repo's worktree. It is also no longer *told*
where any of those are — every ambient `ADLC_*` variable is withheld from the
model-plane environment, and what the charter needs (`ADLC_TICKET`,
`ADLC_P4_ENFORCEMENT`) is injected explicitly.

**Not closed:** model-plane **reads** are unbounded, and egress is open, so a
read-and-exfiltrate path remains. Bounding reads means enumerating where every
harness keeps auth on every platform — a macOS Keychain item is not a file at all
— and is not attempted. Running a fleet over a repo you do not trust remains
outside the design's assumptions.

**No new failure mode when there is no backend.** The model plane reuses the
run-wide sandbox decision: a host with no `bwrap`/`sandbox-exec` already refuses
to dispatch at preflight, and `--i-am-in-a-disposable-container` already asserts
the whole run is contained. There is no model-plane-only opt-out.

Each adapter ships a grounded **default invocation** (`agy --print` is verified
against antigravity-booster; `codex exec`, `opencode run`, `cursor-agent -p`, and
the pi headless form are documented defaults with the confidence noted in each
adapter's header). Because harness CLIs evolve, the command and args are
**overridable** via the operator-local `--adapter-command` / `--adapter-args` CLI
flags (and `--model`) — so a CLI change is a one-line fix, and an unknown
`--adapter` fails closed at run start. With a quartermaster registry engaged the
argv overrides are refused outright, because the registry picks an adapter per
ticket and one global binary cannot serve them all. Live
end-to-end behavior per harness should be verified against the installed CLI.

## Supply — the quartermaster registry (optional)

When an operator-local channel registry exists, it — not `--adapter`/`--model` —
decides the `{adapter, model, transport}` for **each ticket**, routed by
[`@adlc/quartermaster`](../quartermaster) from the ticket's category and CPM
float. The layer engages when `ADLC_QUARTERMASTER_REGISTRY` is set or
`$XDG_CONFIG_HOME/adlc/quartermaster.json` exists; with neither, fleet behaves
exactly as documented above.

Once engaged it is **fail-closed**: a missing, disabled, or invalid registry
aborts before dispatch, and `--adapter-command`/`--adapter-args` are refused
(one global binary cannot serve a per-ticket adapter choice, and a wholesale argv
override would discard the forced model). `fleet run --dry-run` prints the
resolved seat and the argv the adapter itself renders, in text or `--json`.

Nothing in the repo under review participates: a registry-shaped file inside the
tree is ignored with a notice, and a configured path that is relative or inside
the repo disables loading rather than reading it. Schema and the documented
limits: [`docs/integrations/quartermaster-registry.md`](../../docs/integrations/quartermaster-registry.md).

## Configuration (`.adlc/config.json`)

```json
{
  "fleet": {
    "gate": { "build": "npm run build --workspaces --if-present", "test": "npm test" },
    "init": "npm install",
    "adapterStdin": false,
    "concurrency": 2,
    "base": "main",
    "timeoutMinutes": 30,
    "prosecuteFailOn": "medium",
    "allowedCommands": ["npm test", "npm run build:*", "node --test *"]
  }
}
```

`fleet.reviewMaxBytes` (default `262144`) is forwarded to the inner
`adversarial-review` as `--max-bytes`; `--allow-summary-review` is never passed,
because above the reviewer's grounding limit a summary-only review silently
drops every finding — a false green, not a review.

## Composing fleet — the operator-local extensions

An orchestrator that composes fleet (the issue autopilot,
[`docs/specs/issue-autopilot-local.md`](../../docs/specs/issue-autopilot-local.md)
§14) needs to hand it one ticket, a budget, a quota gate and a containment
profile, and to read a machine-readable outcome back. Every knob below is
**operator-local**: honoured from argv only, and a value under the `fleet` key of
`.adlc/config.json` is warned (`SECURITY: … operator-local … — ignored`) and
ignored, exactly like `fleet.adapter`/`fleet.model`. None of them changes fleet's
behaviour when absent.

| Flag | Effect |
| --- | --- |
| `--no-pr` | Skip the run-end PR; the integration branch is left for the caller. |
| `--no-complete` | Skip `completeTicketOnIntegration` after the post-merge gate; the caller owns ticket completion. |
| `--dead-end-file <path>` | The file's content (fenced, 12 000-char cap) is the initial dead-end material for strike 1, so a retry can hand fleet the previous round's failure. |
| `--max-strikes <n>` | Strike cap, integer 1..50 (default 2). |
| `--wall-clock-minutes <m>` | External deadline for the WHOLE run: nothing new is dispatched after it, a strike it cuts short has its process group killed (SIGTERM, then SIGKILL after 15 s), the run records reason `wall-clock`, exits 2 and stays resumable. |
| `--charter-file <path>` | Appended to the builder prompt AFTER the Constraints block (the constraints stay authoritative). |
| `--pre-strike-argv <json-array>` + `--pre-strike-env <json-object>` | A command run before EVERY strike with an argv array and no shell, with EXACTLY the given environment (fleet adds nothing; `ADLC_MANIFEST_KEY` in it is rejected); `argv[0]` must be absolute. Non-zero exit → the ticket pauses (`quota-paused`, exit 2) and an identical re-invocation resumes it via the existing status reconciliation — there is no `--resume` flag and none is needed. |
| `--model-plane-read host\|bounded` + `--model-plane-read-only <abs,…>` | `bounded` gives the MODEL plane the sandbox module's bounded read policy (worktree + synthetic home + the allowlist) — the fixed system roots the host has (`/usr`, `/lib`, `/lib64`, `/etc/ssl`, `/etc/resolv.conf`, `/etc/hosts`) are always in it, so TLS and name resolution work for every adapter; the flag EXTENDS that set plus a private empty tmpfs at `/tmp`; a FILE entry is bound as a single file, so individual executables can be exposed without their parent directory. |
| `--model-plane-git mirror` + `--model-plane-git-mirror <abs bare repo>` | The worker's worktree is cut from the caller-supplied bare mirror (its only git database); after the worker exits the branch is fetched back into the caller repository with a compare-and-swap (`fetch` to a temp ref → `merge-base --is-ancestor` → `update-ref … <cutTip>` → delete the temp ref) and gates/prosecution/merge run on that branch as in shared mode. Any step failing → reason `mirror-fetch-failed`, ref untouched. Requires `bounded` reads. |
| `--model-plane-egress open\|allowlist` | `allowlist` runs the model plane with `--unshare-net` plus a host-side CONNECT proxy on a unix socket whose only permitted targets are the adapter's declared model hosts, bridged to `127.0.0.1` inside the sandbox (`HTTPS_PROXY`/`HTTP_PROXY` set, `NO_PROXY` empty). |
| `--worker-deps <abs node_modules>` | A plain copy (never an npm run) of a caller-built dependency tree into the worker worktree before every strike; the configured `init` does not run. |

### The `--json` result and the reason set

`fleet run --json` prints ONE document on stdout (human lines go to stderr):
`fleetRunId`, `exitCode`, `reason`, `results`, `strikes`, `strikesConsumed`,
`review: { provider, verdict, revision, rounds }` (top level for a single-ticket
run; always per ticket under `tickets`), and the effective policy echo
(`readPolicy`, `privateTmp`, `gitSource`, `mirror`, `egress`, `egressAllowlist`,
`homeBinds`, `writableRoots`).

**`reason` is authoritative for callers; the exit code is unchanged.** Every
non-zero exit carries one. Ticket outcomes come from the closed set

`quota-paused` · `lock-held` · `wall-clock` · `strikes-exhausted` ·
`ticket-blocked` · `flail` · `review-unavailable` · `mirror-fetch-failed`

(`quota-paused`/`wall-clock` are resumable pauses, `lock-held` is a skip to
retry later, the rest are terminal for the ticket). Run-level failures that are
NOT ticket outcomes — `quarantined`, `pr-open-failed`, `preflight`,
`resume-refused`, `dispatch-refused` — use the same key but sit outside that
set, so a caller keying on the closed enum treats them as an operational error
needing a human, which is the right reading. A `dispatch-refused` ticket is left PAUSED
with its strike handed back: fix the sandbox policy and resume.

## Exit codes

- `0` — every dispatched ticket merged (or a clean dry-run).
- `1` — operational error (bad config, dirty tree, lock held, missing gate,
  sandbox precondition unmet).
- `2` — at least one ticket failed, was blocked, or was PAUSED by the pre-strike
  command / the external wall clock (see `--json` `reason`).

## ADLC phase

P4 (parallel build) + P5 (per-ticket prosecution). The fleet is the orchestrator
that makes ADLC P4 parallelism executable; it consumes the ticket DAG certified
by `merge-forecast` (D2) and routes each ticket through the gates.

## Core gaps

None required core changes. The fleet delegates all ticket primitives
(`loadTickets`, `topoSort`, `scopesOverlap`, `globMatch`, `inScope`) to
`@adlc/core` and adds no third-party runtime dependency.
