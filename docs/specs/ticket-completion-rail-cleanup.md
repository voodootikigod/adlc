# Spec — ticket-completion / rail-cleanup lifecycle step (#198)

**Phase:** P1 record for ticket **T48**. Closes the completion half of the T36 rails
lifecycle: shipped tickets that froze rails are never marked `completed: true`, so their
rails never expire and freeze unrelated future work.

## Problem

`completed: true` on a ticket is what expires its build-time rails (T36, enforced in
`scripts/rails-guard-ci.mjs`: the base-rail union skips `t.completed === true`). But
`rails-guard-ci.assertBaseTicketContractsPreserved` denies field changes to existing base
tickets in an ordinary PR — `isCompletionAnnotationOnly` exempts **only** a rails-*less*
ticket gaining `completed: true`. So completing a **railed** shipped ticket requires the
protected-base admin ceremony (a direct push to `main`, or `ADLC_RAILS_BYPASS=1`), and
nothing in the lifecycle performs or even surfaces it. Result: railed shipped tickets stay
active, their rails stay frozen, and the next unrelated PR touching those paths is blocked
(this happened to PR #196; PR #199 cleared it with six manual `completed: true` lines).

`packages/ticket-prune` already detects shipped tickets and tombstones the rails-*less* ones
via a raw add-only `completed: true` edit in an ordinary PR. It already classifies the
railed shipped ones as `needsCeremony` (`blocker: 'rails-freeze'`) — but only inside the
`--write` path, so **dry-run reports `needsCeremony: []`** and the drift is invisible until
someone tries to write, and there is **no command to apply the ceremony**.

## Acceptance criteria

- **AC1 — dry-run surfaces the drift.** `ticket-prune` with no `--write` computes and
  reports the `needsCeremony` set (active, i.e. `completed !== true`, rail-freezing, shipped
  tickets) in both the table and `--json` output — the same set the `--write` path computes;
  the rails-freeze / preexisting-completed-field classification is a pure function shared by
  both paths. Verified by `node --test packages/ticket-prune/test/run.test.mjs` and
  `packages/ticket-prune/test/format.test.mjs` asserting a shipped railed active fixture
  ticket appears in `needsCeremony` (`blocker: 'rails-freeze'`) and in both renderers, where
  the baseline today returns `needsCeremony: []`.
- **AC2 — ceremony is admin-gated.** `--ceremony` writes nothing and returns `{ ok: false }`
  (bin exits non-zero) unless `ADLC_RAILS_BYPASS=1` is set. Verified by a
  `packages/ticket-prune/test/run.test.mjs` case that invokes `--ceremony` with the env
  unset and asserts the tickets file is byte-identical afterward.
- **AC3 — ceremony completes railed shipped tickets, add-only.** With `ADLC_RAILS_BYPASS=1`
  and `--ceremony --write`, each `needsCeremony` rails-freeze ticket gains exactly
  `completed: true` (no other field changed, mirroring PR #199 — no manifest entry) and is
  reported under `ceremonyCompleted`; a still-active railed ticket (scope not shipped) is
  not completed. Verified by `node --test packages/ticket-prune/test/run.test.mjs` asserting
  the resulting ticket diff is add-only and the active railed ticket is untouched.
- **AC4 — rails expire after completion (T36).** After the ceremony completes a railed
  ticket, the rails-guard base-rail union (the `t.completed === true` skip) no longer
  includes that ticket's rails. Verified by a `packages/ticket-prune/test/run.test.mjs` case
  computing the union before and after and asserting the completed ticket's rails drop out.
- **AC5 — existing contract preserved.** Rails-less shipped tickets are still tombstoned by
  the ordinary `--write` path; `preexisting-completed-field` tickets are still reported and
  never rewritten (ceremony does not touch them). Verified by the existing
  `node --test packages/ticket-prune/test/*.test.mjs` cases passing unchanged plus a new
  case asserting `--ceremony` leaves a `preexisting-completed-field` ticket untouched.
- **AC6 — the gate is unchanged.** `scripts/rails-guard-ci.mjs` (a declared rail on T48) is
  not modified. Verified by `test -z "$(git diff origin/main...HEAD -- scripts/rails-guard-ci.mjs)"`.
- **AC7 — maintenance documents the lifecycle step.** `/adlc:adlc-maintain` step 3 (every
  plugin copy: adlc-claude-code, adlc-cursor, adlc-opencode, adlc-pi) explains the
  railed-active-shipped drift signal and gives the exact ceremony command. Verified by
  `grep -l ceremony` across the four maintain docs returning all four paths.
- **AC8 — one-time sweep documented.** This spec lists the current railed-active shipped
  tickets and the exact admin-path command to complete them; the ids match
  `ticket-prune --json` `needsCeremony` on `origin/main`. Verified by running
  `node packages/ticket-prune/bin/ticket-prune.mjs --json --base-ref origin/main` and
  diffing the printed `needsCeremony` ids against the table below.

## One-time sweep (admin action on `main`, NOT part of the T48 PR)

Measured on `origin/main` at authoring time, the active rail-freezing shipped tickets are:

| Ticket | Rails (count) | Title (abbrev) |
| --- | --- | --- |
| `T-01KXPD8KJ9H6M6DFA83Y82A1Z1` | 3 | validated `current-ticket.json` contract |
| `T7` | 8 | Fenced JSON block codec |
| `T8` | 10 | Pull: GitHub read adapter + 3-way reconcile |
| `T9` | 13 | Push + create: write-back |
| `T42` | 1 | Specify and build @adlc/fleet |
| `T43` | 1 | Make @adlc/fleet real |
| `T44` | 1 | Flush @adlc/fleet worker dispatch |
| `T46` | 1 | Flush the ADLC through Codex-native install |

Re-measure with AC8's command before acting (the set moves as work merges). Then, **on a
protected-base admin checkout of `main`** (this cannot land in an ordinary PR):

```sh
# Review first:
node packages/ticket-prune/bin/ticket-prune.mjs --json --base-ref origin/main   # inspect needsCeremony

# Apply the ceremony (admin override recorded), then push directly to main:
ADLC_RAILS_BYPASS=1 node packages/ticket-prune/bin/ticket-prune.mjs --ceremony --write --base-ref origin/main
```

Each completed ticket's rails then auto-expire per T36, unfreezing their paths for future
PRs. Confirm any ticket that is genuinely still in flight is excluded before pushing — the
`scope`-shipped inference is deterministic but an operator should sanity-check the list.

## Out of scope

- Merge-triggered GitHub Actions automation (#198 direction #2).
- A standalone rail-decay gate package (#198 direction #3).
- Landing the one-time sweep on `main` (a separate admin push, like PR #199).
