# ADR 0016: Issue autopilot on a local, quota-gated substrate

**Status:** Accepted

**Date:** 2026-08-28

**Decider:** Chris Williams

**Related:** [Issue autopilot (local substrate) spec](../specs/issue-autopilot-local.md),
issue #237 (the original GitHub-Actions design, T55), [ADR-0010](./0010-adlc-fleet-orchestration.md)
(fleet orchestration), [ADR-0007](./0007-cross-model-review.md) (cross-model review),
PRs #877 / #880 (the spec), the fleet-extensions ticket T-01M0Z3G8MATGSZ0ECB6FAE0R08
and the build ticket T-01M0Z3FN7SAS4HAH7CS63YQ0DH.

## Context

Issue #237 designed an autopilot that turns labeled GitHub issues into
ADLC-gated PRs, on GitHub Actions. Its gate composition, triage contract,
protected-path denylist and PR-upsert rule were sound and are kept verbatim. Its
substrate was not: a hosted runner pays metered API rates for work a
subscription already covers, cannot see the operator's quota windows, and holds
the manifest key in CI secrets where every workflow author can reach it.

The operator's constraints (grill-me session 2026-08-26, recorded in spec §0):
run locally on a subscription, start nothing when either quota window is at or
past 50 % used, keep the reviewer on a different provider's quota (Codex), keep
P6 human, and make every escalation a GitHub label the operator can flip from a
phone.

## Decision

1. **Substrate: a `systemd --user` service composing `@adlc/fleet`.** The
   autopilot adds no gate logic. It is an issue picker + quota gate + rest loop
   that dispatches `fleet run --tickets <id>` one ticket per run, so each issue
   gets its own branch and PR. Sandbox, deterministic gates, the blocking
   cross-model review loop and worktree hygiene are fleet's; the autopilot
   extends fleet with operator-local flags (`--no-pr`, `--no-complete`,
   `--max-strikes`, `--wall-clock-minutes`, `--pre-strike-argv`, bounded model
   plane, git mirror, egress allowlist, `--worker-deps`) and a `--json` result
   with a closed `reason` set.
2. **The quota gate is a literal start gate**: `GET /api/oauth/usage` with the
   harness's own bearer, both windows `< threshold` (default 50, tightenable to
   1, never loosenable), the effective model's scoped window included, unknown =
   no run, re-sampled before every Claude-consuming step (60 s validity), with
   a reserve for every start after the first in an iteration. Overshoot is
   detected by reconciliation and made visible, never prevented (accepted
   residual).
3. **Trust stays with the orchestrator.** The manifest key reaches exactly seven
   key-bearing children; the worker holds only its own harness credential, in a
   synthetic HOME it cannot write back from, behind an egress allowlist naming
   only the model API. The worker's git database is a per-run bare mirror
   holding nothing but the pinned baseline and the issue branch; gates run in
   per-gate throwaway clones inside a network-denied sandbox, and every
   orchestrator-side verdict is bound to the attested OID by lease-guarded
   pushes and post-push verification.
4. **`.adlc/config.json` lands by deliberate admin merge** under the
   `trust-root-change` label (PR #900): the #141 non-author-CODEOWNER ceremony
   is unsatisfiable on a single-owner repository. Recorded as accepted residual
   §11.1 item 5.
5. **P6 stays human.** The autopilot never merges, never pushes `main`, never
   deletes a remote branch on its own (an operator-invoked `reset
   --delete-remote` is lease-guarded and watched for a PR that appears after
   the delete).

## Consequences

- The backlog is worked while the operator is away, at subscription cost, with
  every outcome visible as a label or a PR and every artifact carrying manifest
  evidence bound to the reviewed revision.
- The spec's 163 acceptance criteria are enforced by an explicit AC registry
  (`packages/autopilot/test/ac-registry.mjs`) with a mutation fixture per
  criterion, so coverage is a proof, not a name match.
- Fleet gained a second containment profile (bounded reads) that only bubblewrap
  can express; the autopilot is Linux-only in v1 by construction.
- A GitHub ruleset restricting pushes to `refs/heads/adlc/autopilot/**` to the
  operator identity (spec R12) is recommended but not assumed: another writer on
  the autopilot's branch is detected, not prevented.
- Follow-ups: the Remote Control hub (spec §10.1), ingesting the per-run
  findings ledgers into P7, `scripts/preflight.mjs --no-fetch --sandboxed` (R13)
  so the script itself can be the sandboxed gate runner.
