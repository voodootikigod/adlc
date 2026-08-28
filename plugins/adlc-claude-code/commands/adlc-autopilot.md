---
description: Inspect or drive the local issue autopilot — status, a dry-run of the next issue, the ranked selection — and manage its systemd --user service.
argument-hint: [status | select | once --issue <n> --dry-run | quota]
---

# /adlc:adlc-autopilot — the quota-gated issue-to-PR loop

The autopilot (`@adlc/autopilot`, spec `docs/specs/issue-autopilot-local.md`)
picks the next GitHub issue, shapes an ADLC ticket, dispatches ONE sandboxed
`adlc fleet` run per issue, runs the outer gates, attests with a Codex review and
opens the PR. It never merges (P6 stays human), never pushes to `main`, and
starts a Claude-consuming step only when both quota windows are under the
threshold. This command is a thin operator window onto it; it does not replace
the service.

Prerequisite: `adlc --version` works and the repo carries `.adlc/config.json`
with an `autopilot` block. Every subcommand below is read-only or a dry-run.

## 1. Where does it stand?

```
adlc autopilot status --json
```

Renders the local status file plus the preflight verdict: pinned tools and URLs,
quota windows (and when they reset), the open autopilot PRs, blocked/stale/ci-red
issues, `remoteRefsLeft` with the exact deletion command, orphans, and
`lastError`. A preflight code (`repo-mismatch`, `key-file-insecure`,
`spec-approval-stale`, `plugin-parity`, …) names exactly what to fix.

## 2. What would it do next?

```
adlc autopilot select --top 10 --json
```

The ranked candidate list with each issue's score breakdown (§4.3) and, for the
excluded ones, the rule that excluded it (`not-authorized`, `protected-path`,
`open-pr`, `remote-ref-exists`, `shaping-failed`, …).

## 3. Dry-run one issue

```
adlc autopilot once --issue <n> --dry-run --json
```

Prints the full plan — baseline OID, the shaped ticket (a deterministic
placeholder unless `--dry-run-shape` spends the one gated shaping call), the
exact fleet argv, the PR title/body — and performs zero mutations: no lock, no
fetch, no worktree, no `gh` write, no manifest append. The plan is always
`complete: false` with an `incomplete` list naming what a dry-run cannot check
(`fleet-dry-run-needs-worktree`, `baseline-not-local`).

## 4. Quota

```
adlc autopilot quota --json
```

The gate's current reading from the usage endpoint (or the `/usage` fallback),
the effective model's scoped window, and whether a start would be admitted.

## 5. The service

```
systemctl --user status adlc-autopilot
systemctl --user start  adlc-autopilot
systemctl --user stop   adlc-autopilot
journalctl --user -u adlc-autopilot -f
```

`adlc autopilot init --service` prints the unit (`--write` installs it to
`~/.config/systemd/user/`); `adlc autopilot init --labels` creates the eight
`adlc:*` labels idempotently. Unblocking an issue is a label flip on GitHub:
remove `adlc:autopilot-blocked` / `-stale` / `-ci-red` /
`adlc:needs-clarification` (an admin/maintain actor) and the next iteration
retires or re-arms the run; add `adlc:autopilot` to jump the queue;
`adlc:autopilot-skip` to exclude.

## 6. Summarize

Report the preflight verdict, the quota reading, the next candidate and why,
any quarantined runs and the operator action each needs.
