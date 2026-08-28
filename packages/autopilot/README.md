# @adlc/autopilot

Quota-gated local issue-to-PR loop. Picks the next GitHub issue from the open
backlog, shapes an ADLC ticket, dispatches **one sandboxed `@adlc/fleet` run per
issue**, runs the outer gates in throwaway sandboxed clones, attests with a
cross-model (Codex) review bound to the exact tree it pushes, and opens the PR.
P6 (merge) stays human. Every escalation is a GitHub label the operator can flip
from a phone.

Design contract: [`docs/specs/issue-autopilot-local.md`](../../docs/specs/issue-autopilot-local.md)
· decisions: [`docs/adr/0016-issue-autopilot-local-substrate.md`](../../docs/adr/0016-issue-autopilot-local-substrate.md).

## What it does

- **Composes fleet, adds no gate logic.** The autopilot is an issue picker + a
  quota gate + a rest loop around `fleet run --tickets <id> --no-pr
  --no-complete --max-strikes … --wall-clock-minutes … --pre-strike-argv …
  --model-plane-read bounded --model-plane-git mirror --model-plane-egress
  allowlist --worker-deps …`.
- **The quota gate is literal.** A Claude-consuming step starts only when the
  5-hour AND the 7-day windows (and the worker model's scoped window) read
  `< threshold` (default 50 %, tightenable never loosenable), sampled at most
  60 s before the start, with a reserve for every start after the first in an
  iteration. Unknown quota = no run.
- **Trust stays here.** The manifest key reaches exactly seven key-bearing
  children (`KEY_BEARING_ARGV` in `lib/keys.mjs`). The worker holds only its
  harness credential, in a synthetic HOME bound read-only, behind an egress
  allowlist naming only the model API, with a per-run bare git mirror as its
  only git database. Gates run in per-gate clones inside a network-denied
  sandbox. Every push is lease-guarded and verified at the endpoint.
- **Everything is a state machine on disk.** One run record per issue under
  `.adlc/autopilot-runs/`, written before the world-effect it names, so a crash
  between the two is disambiguated by inspecting git/`gh` on the next
  iteration. Deletion of anything is ownership-checked and never forced.

## Usage

```sh
adlc autopilot loop   [--rest 10m] [--dry-run]                       # the service body
adlc autopilot once   [--issue <n>] [--force] [--dry-run] [--dry-run-shape]
adlc autopilot status [--json]
adlc autopilot select [--top <n>] [--json]
adlc autopilot quota  [--json] [--model <m>] [--quota-threshold <T>] [--quota-reserve <R>]
adlc autopilot triage --issue <n> [--json]
adlc autopilot reset  --issue <n> ( --confirm-delete <OID> [--delete-remote] | --attempts )
adlc autopilot init   [--labels] [--service] [--write]
```

Global operator-local flags: `--repo <owner/name>` (or `ADLC_AUTOPILOT_REPO`;
required for `loop`/`once`), `--model` (default `opus`), `--adapter`
(`claude-code` only in v1), `--quota-threshold` (1–50), `--quota-reserve`
(0–49, `< threshold`), `--trusted-bin-dirs <abs,…>`, `--ssh-identity <abs>`.
Precedence: CLI flag > `ADLC_AUTOPILOT_<UPPER_SNAKE>` > default. Every
subcommand exits 0/1/2 and supports `--json`.

## Configuration

Repo-committed (`.adlc/config.json`, a trust root): the `fleet` block fleet
reads, an `autopilot` block (`restMinutes`, `maxOpenPrs`, `maxRounds`,
`wallClockMinutes`, `ciFixRounds`, `ciWatchMinutes`, `reviewMaxBytes`, `repo`,
`dispatchApproval`, `protectedPathsExtra`) that the CLI may lower but never
raise, and a `ticketSync` block validated against ticket-sync's schema. A
committed `quotaThreshold`/`quotaReserve`/`model`/`adapter` is warned and
ignored — the quota is the operator's.

## Service

`adlc autopilot init --service --repo <owner/name>` prints a `systemd --user`
unit (`--write` installs it): absolute paths, `EnvironmentFile=<repo>/.env.local`
(the manifest key, file must be `0600`), `Restart=on-failure`,
`KillMode=control-group`, exactly one SSH auth mode. Then
`systemctl --user enable --now adlc-autopilot`.

## Exit codes

- `0` — the iteration completed (a run, a CLARIFY, a rest, or a clean dry-run).
- `1` — operational error: preflight red (the code names the item —
  `untrusted-tool:<name>`, `repo-mismatch`, `key-file-insecure`,
  `spec-approval-stale`, `plugin-parity`, …), `lock-held`, `bad-input:<field>`.
- `2` — a gate refused: a pinned issue is excluded (the rule is named), a
  `reset` was refused, a run ended `blocked`.

## ADLC phase

P0 (triage) through P5 (prosecution) as an unattended loop; P6 is the human's.
It consumes the tickets `@adlc/tickets` stores, the gates `spec-lint`,
`coldstart`, `rails-guard`, `hollow-test`/`mutation-gate`, `prosecute
record-cross-model` and `gate-manifest` record, and `fleet` for P4.

## Tests

`node --test packages/autopilot/test/` — offline, with fake `gh`/`claude`/fleet
children and real temporary git repositories. `test/ac-registry.mjs` maps every
spec §16 criterion to exported test functions and a mutation fixture;
`test/spec-coverage.test.mjs` parses the spec at the pinned blob and fails on any
criterion without a load-bearing test. Real-bwrap and real-sshd checks skip
loudly when the host lacks them.

## Core gaps

None. Runtime dependencies are `@adlc/core`, `@adlc/fleet` and `@adlc/tickets`
only; the ticket-sync config schema is read from the pinned blob and evaluated
by `lib/schema-lite.mjs` rather than importing `@adlc/ticket-sync`.

## The AC coverage gate

`npm run test:gate -w packages/autopilot` runs `test/spec-coverage.test.mjs` with
`AUTOPILOT_GATE_FULL=1`: every §16 criterion of the spec is registered
(`test/ac-registry.mjs`), every registered function is executed, and every
criterion's mutation fixture is proven to BITE. The execution passes take ~25
minutes; without the variable only the static checks run (the root suite and
the mutation gate stay fast). Run the full gate before merging a change to this
package.
