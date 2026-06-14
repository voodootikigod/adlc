# ADLC Toolkit Documentation

This directory documents the Agentic Development Lifecycle toolkit: a workspace of
zero-dependency Node.js packages for specifying, gating, routing, reviewing, and
ratcheting agentic software work.

The package READMEs remain the source of truth for full CLI flag details, JSON schemas,
and examples. These docs provide the toolkit-level map that is missing from individual
package READMEs.

## Start here

- [Toolkit guide](./toolkit.md) explains how the packages fit into the ADLC flow.
- [Package reference](./package-reference.md) lists every package, binary, phase, and
  primary README source.

## Repository shape

- `packages/*` contains one npm workspace package per tool.
- `packages/core` contains shared primitives used by the CLIs.
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

