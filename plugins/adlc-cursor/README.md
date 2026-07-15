# @adlc/cursor

ADLC ([Agentic Development Lifecycle](https://www.agenticlifecycle.ai)) native
integration for [Cursor](https://cursor.com): a marketplace plugin with
`preToolUse` rails-guard dispatcher, `afterFileEdit` audit, advisory shell
notice, `stop` / `beforeSubmitPrompt` hooks, phase skills, and the full
`/adlc-*` command palette.

## Install (preferred)

From a clone of this repository (Cursor plugin marketplace):

1. Add the repo as a Cursor plugin marketplace (see
   [Cursor plugins](https://cursor.com/docs/reference/plugins) — root
   `.cursor-plugin/marketplace.json` lists `adlc-cursor`).
2. Install the `adlc-cursor` plugin.
3. Install the gate toolkit and initialize the repo runtime:

```sh
npm install -g @adlc/cli
adlc init --harness cursor
```

4. Wire the unbypassable CI rail-freeze gate:
   [`docs/ci/rails-guard.yml`](https://github.com/voodootikigod/adlc/blob/main/docs/ci/rails-guard.yml).

## Legacy / local-dev fallback

```sh
npm install -g @adlc/cli
npx @adlc/cursor .
```

The scaffolder is idempotent — re-running (or `/adlc-init`) merges into any
existing `.cursor/hooks.json` without touching your other hooks. Prefer the
marketplace path so hooks/skills update with the plugin instead of copied
project files.

## What you get

- **`preToolUse` dispatcher** — rails decision first; frozen-rail edits denied.
- **`afterFileEdit` audit** — observational rail + flail notice.
- **`beforeShellExecution` advisory** — honesty nudge; never denies.
- **`stop` / `beforeSubmitPrompt`** — stop-audit + preflight (Cursor-documented).
- **Skills** — `adlc` phase router + `adlc-init`.
- **Command palette** — `/adlc-init`, `/adlc-ticket`, `/adlc-spec`,
  `/adlc-approve-spec`, `/adlc-decompose`, `/adlc-verify-build`,
  `/adlc-prosecute`, `/adlc-distill`, `/adlc-maintain`.
- **`.cursor/rules/adlc.mdc`** — phase-router rule (also delivered via plugin).

## Docs

Full guide: [docs/integrations/cursor.md](https://github.com/voodootikigod/adlc/blob/main/docs/integrations/cursor.md).

MIT © Chris Williams
