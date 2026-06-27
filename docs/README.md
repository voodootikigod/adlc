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
- [Package reference](./package-reference.md) lists every package, binary, phase, and
  primary README source.
- [Ticket authoring](./ticket-authoring.md) defines the canonical ticket schema that
  all gates and both integrations read.

## Architecture decision records

- [ADR 0001](./adr/0001-codex-native-adlc-integration.md) — Codex-native integration
  plan and dispatcher contract.
- [ADR 0002](./adr/0002-adlc-command-reconciliation.md) — `adlc` command
  reconciliation across integrations (Option D: separate concern-focused bins).
- [ADR 0003](./adr/0003-adlc-claude-code-plugin.md) — Claude Code plugin design,
  hook strategy, and rail-guard enforcement model.

## CI templates

- [`ci/rails-guard.yml`](./ci/rails-guard.yml) — required check blocking PRs that
  touch frozen rails. Works with both integrations.
- [`ci/adlc-maintenance.yml`](./ci/adlc-maintenance.yml) — weekly advisory cron for
  skill-rot, model-ratchet, and gate-fuzzing checks.

## Repository shape

- `packages/*` contains one npm workspace package per tool.
- `packages/core` contains shared primitives used by the CLIs.
- `plugins/adlc-claude-code/` contains the Claude Code plugin (skill, commands, hooks, subagent).
- `plugins/adlc-codex/` contains the Codex integration (hooks and skills).
- `plugins/adlc-pi/` contains the Pi harness integration (TypeScript, skills, tests).
- `.adlc/` is the runtime convention used by several tools for tickets, ledgers, lessons,
  and gate evidence.
- `docs/` contains toolkit-level documentation and long-form lifecycle material.

## Runtime baseline

The workspace requires Node.js 18 or newer. Package manifests expose CLIs through each
package's `bin` field, and the root test script runs each package test suite with
`node --test`.

```sh
npm test
```

## Archive

- [archive/](./archive/README.md) — superseded proposals retained for historical reference.
