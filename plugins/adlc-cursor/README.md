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
   `.cursor-plugin/marketplace.json` is marketplace `adlc-plugins` and lists
   **ADLC for Cursor** / `adlc-cursor`).
2. Install **ADLC for Cursor** (`adlc-cursor`) — not a Claude Code–named `adlc`
   entry from this monorepo.
3. In Cursor, run `/adlc-init` (or):

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

- **`sessionStart`** — ticket/rails context injection (best-effort) + session id env.
- **`preToolUse` dispatcher** — rails decision first; frozen-rail edits denied.
- **`afterFileEdit` audit** — observational rail + flail notice.
- **`beforeShellExecution` advisory** — honesty nudge; never denies.
- **`stop` / `beforeSubmitPrompt`** — stop-audit + preflight (Cursor-documented).
- **MCP (one-root channel proven / rebind unverified)** — a live test on
  Cursor Desktop 3.20.10 proved `${CURSOR_PLUGIN_ROOT}` expansion in `args` and
  `cwd`, bundled startup without plugin-cache `node_modules` or a consumer
  shim, and a `roots/list` response. The post-fix run bound, exposed
  `adlc_gate` / `adlc_prosecute`, and returned `ok` / `exitCode: 0` for
  `adlc_gate gate-manifest show`. The proxy accepts Cursor's bare absolute-path
  Root values as well as `file://` URIs, then runs `adlc mcp-server` with the
  resolved consumer cwd. It requires a global `@adlc/cli` installation
  resolvable by Cursor's Node/npm environment (`npm i -g @adlc/cli`) and never
  launches a Windows `.cmd` shim. `roots/list_changed` rebind and live
  multi-root refusal remain unverified.
- **Skills** — `adlc` phase router + `adlc-init`.
- **Command palette** — `/adlc-init`, `/adlc-ticket`, `/adlc-spec`,
  `/adlc-approve-spec`, `/adlc-decompose`, `/adlc-verify-build`,
  `/adlc-prosecute`, `/adlc-distill`, `/adlc-maintain`.
- **`.cursor/rules/adlc.mdc`** — phase-router rule (also delivered via plugin).

## Docs

Full guide: [docs/integrations/cursor.md](https://github.com/voodootikigod/adlc/blob/main/docs/integrations/cursor.md).

MIT © Chris Williams
