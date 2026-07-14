# ADLC Toolkit Documentation

This directory documents the Agentic Development Lifecycle toolkit: a workspace of
zero-dependency Node.js packages for specifying, gating, routing, reviewing, and
ratcheting agentic software work.

The package READMEs remain the source of truth for full CLI flag details, JSON schemas,
and examples. These docs provide the toolkit-level map that is missing from individual
package READMEs.

## Start here

- [Toolkit guide](./toolkit.md) explains how the packages fit into the ADLC flow.
- [Codex integration](./integrations/codex.md) explains installation, usage, and the
  current gaps against the formal ADLC doctrine.
- [Claude Code integration](./integrations/claude-code.md) explains how to install and
  use the Claude Code plugin, including lifecycle coverage and known gaps.
- [Pi integration](./integrations/pi.md) explains the Raspberry Pi harness integration.
- [opencode integration](./integrations/opencode.md) explains how to install and use the
  OpenCode plugin (rails-guard hook, command suite, keyless gate bridge, session hooks,
  prosecutor lenses) — all six plan phases shipped.
- [Google Antigravity integration](./integrations/antigravity.md) explains how to install
  and use the Antigravity plugin, including the advisory in-session hook and unbypassable
  CI gate.
- [Package reference](./package-reference.md) lists every package, binary, phase, and
  primary README source.
- [Ticket authoring](./ticket-authoring.md) defines the canonical ticket schema that
  all gates and both integrations read.
- [ADLC 1.3 ticket-store release notes](./releases/1.3-sharded-ticket-store.md) explain
  the sharded default, legacy compatibility bridge, migration approval, and 2.0 removal.

## Architecture decision records

- [ADR 0001](./adr/0001-codex-native-adlc-integration.md) — Codex-native integration
  plan and dispatcher contract.
- [ADR 0002](./adr/0002-adlc-command-reconciliation.md) — `adlc` command
  reconciliation across integrations (Option D: separate concern-focused bins).
- [ADR 0003](./adr/0003-adlc-claude-code-plugin.md) — Claude Code plugin design,
  hook strategy, and rail-guard enforcement model.

## CI templates

- [`ci/rails-guard.yml`](./ci/rails-guard.yml) — required check blocking PRs that
  touch frozen rails. Works with both integrations. **Private-repo caveat:** on a
  private repo on GitHub's free plan, both required-status-check APIs (branch
  protection, rulesets) return 403 — see
  [`ci/rails-guard-private-repo-fallback.md`](./ci/rails-guard-private-repo-fallback.md)
  for folding this check into an already-required job instead.
- [`ci/adlc-maintenance.yml`](./ci/adlc-maintenance.yml) — weekly advisory cron for
  skill-rot, model-ratchet, and gate-fuzzing checks.
- [`ci/adversarial-review.yml`](./ci/adversarial-review.yml) — risk-gated PR check that
  runs the `adversarial-review` multi-provider quorum on ADR-0007 high-blast-radius paths
  (auth/trust boundary, deny paths, secrets, data-loss ops, schema/migration, CI/CD) and a
  cheap single-model pass otherwise; records the verdict via `gate-manifest`.

## Repository shape

- `packages/*` contains one npm workspace package per tool.
- `packages/core` contains shared primitives used by the CLIs.
- `plugins/adlc-claude-code/` contains the Claude Code plugin (skill, commands, hooks, subagent).
- `plugins/adlc-codex/` contains the Codex integration (hooks and skills).
- `plugins/adlc-pi/` contains the Pi harness integration (TypeScript, skills, tests).
- `.adlc/` is the runtime convention used by several tools for tickets, ledgers, lessons,
  and gate evidence.
- `docs/` contains toolkit-level documentation and long-form lifecycle material.
- `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json` are two
  distinct plugin manifests, not duplicates: the former is the Claude Code plugin
  marketplace format (lists `plugins/adlc-claude-code`), the latter is the generic
  agents marketplace format used by other hosts (lists `plugins/adlc-codex` and
  `plugins/adlc-antigravity`).

## Runtime baseline

The workspace requires Node.js 18 or newer. Package manifests expose CLIs through each
package's `bin` field, and the root test script runs each package test suite with
`node --test`.

```sh
npm test
```

## Archive

- [archive/](./archive/README.md) — superseded proposals retained for historical reference.
