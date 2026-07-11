# @adlc/cursor-package

ADLC ([Agentic Development Lifecycle](https://www.agenticlifecycle.ai)) native integration for
[Cursor](https://cursor.com): a `preToolUse` rails-guard dispatcher, an `afterFileEdit` audit
+ flail notice, an advisory `beforeShellExecution` reminder, and the full `/adlc-*` command
palette (including the sequential five-lens `/adlc-prosecute` loop).

## Install

```sh
# 1. The gate toolkit (the hooks/commands shell out to the `adlc` binary)
npm install -g @adlc/cli

# 2. Bootstrap your project (writes .adlc/config.json + .cursor/hooks.json,
#    rules, and the /adlc-* command palette)
npx @adlc/cursor-package .
```

The scaffold is idempotent — re-running (or the in-Cursor `/adlc-init` command)
merges into any existing `.cursor/hooks.json` without touching your other hooks.

## What you get

- **`preToolUse` dispatcher** — runs the rails decision first; a frozen-rail
  edit is denied before it lands.
- **`afterFileEdit` audit** — a loud notice on a frozen-rail edit that slipped
  past `preToolUse`, plus a flail (edit-churn) reminder. Observational only —
  Cursor's `afterFileEdit` fires after the write and cannot block.
- **`beforeShellExecution` advisory** — an honesty nudge on obvious shell
  writes to the active ticket's rails, not a control.
- **Command palette** — `/adlc-init`, `/adlc-ticket`, `/adlc-spec`,
  `/adlc-approve-spec`, `/adlc-decompose`, `/adlc-verify-build`,
  `/adlc-prosecute`, `/adlc-distill`, `/adlc-maintain`.
- **`.cursor/rules/adlc.mdc`** — the ADLC phase-router rule.

## Docs

Full integration guide: [docs/integrations/cursor.md](https://github.com/voodootikigod/adlc/blob/main/docs/integrations/cursor.md)
in the ADLC repo — the two-layer enforcement model (in-session advisory + the
unbypassable CI rail-freeze gate), the full command reference, and gaps.

MIT © Chris Williams
