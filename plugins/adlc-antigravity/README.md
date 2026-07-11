# @adlc/antigravity

ADLC ([Agentic Development Lifecycle](https://www.agenticlifecycle.ai)) native integration for
[Google Antigravity](https://antigravity.google) (`agy`): a `PreToolUse` rails-guard hook, the
`adlc` phase-router skill, a `prosecutor` agent, and the doctrine skills that keep an active
ticket's scope and frozen rails in front of the model every turn.

## Install

`agy plugin install` always takes a filesystem path — there is no native
`agy install npm:X`. Two ways to get one:

```sh
# From a checkout (recommended today)
agy plugin install /abs/path/to/adlc/plugins/adlc-antigravity

# npm-assisted, once this package is published
npm install @adlc/antigravity
agy plugin install ./node_modules/@adlc/antigravity
```

Then run `/adlc-init` inside your agent session to bootstrap `.adlc/` in your
repository. This package is self-contained by design (no `@adlc/*` runtime
dependencies) because `agy plugin install` copies the plugin without
`node_modules` — see `core-inline.mjs` for the rationale.

## What you get

- **`PreToolUse` rails-guard hook** — denies edits to frozen rails in-session.
  **Advisory, not a guarantee**: `agy` fails **open** on a non-zero hook exit
  (crash, timeout, unsupported platform), so the CI diff gate
  (`scripts/rails-guard-ci.mjs`) is the real, unbypassable control — make it a
  required check.
- **`adlc` doctrine skill** — phase-routes the model through P0–P7.
- **`prosecutor` agent** — a fresh-context P5 reviewer.
- **`/adlc-init` command** — bootstraps `.adlc/` in the target repo.

## Docs

Full integration guide: [docs/integrations/antigravity.md](https://github.com/voodootikigod/adlc/blob/main/docs/integrations/antigravity.md)
in the ADLC repo — the two-layer enforcement model, formal ADLC phase coverage,
and known CLI limitations (e.g. the native marketplace registration gap).

MIT © Chris Williams
