# ADLC for GitHub Copilot CLI

Native [Agentic Development Lifecycle](https://github.com/voodootikigod/adlc)
integration for the **GitHub Copilot CLI** — the 7th ADLC harness. Operate ADLC
gates from inside Copilot with progressive-disclosure skills, rail-protecting
hooks, allowlisted MCP gate tools, and read-only prosecution agents.

Requires the gate toolkit: `npm i -g @adlc/cli`.

## Install

```bash
copilot plugin marketplace add voodootikigod/adlc
copilot plugin install adlc-copilot@adlc
```

## What it wires

| Primitive | Copilot surface | Notes |
| --- | --- | --- |
| Rail protection | `preToolUse` hook | Denies edits to a frozen ticket's rails. |
| Build-gate context fitness | `preToolUse` hook | Runs after rails-guard. |
| Ticket / gate context | `sessionStart`, `preCompact`, `subagentStart/Stop` | Advisory narration. |
| Flail detection | `postToolUse` hook | Advisory repeated-failure notice. |
| Gate evidence + review trigger | `agentStop` hook | Advisory. |
| Gate tools | `.mcp.json` → `adlc mcp-server` | `adlc_gate`, `adlc_prosecute`. |
| Prosecution lenses | `agents/*.agent.md` | Read-only tool allowlists. |
| Phase routing / bootstrap | `skills/` | `adlc`, `adlc-init`, `adlc-ticket`, `adlc-prosecute`, `adlc-distill`, `adlc-maintain`. |

## Enforcement posture (read this)

The `preToolUse` rails-guard hook denies a frozen-rail edit by emitting
`{"reason":"…"}` on stdout — the deny shape verified end-to-end against Copilot
CLI 1.0.73 (the #240 live deny-proof; see
[`docs/integrations/copilot-probe-appendix.md`](../../docs/integrations/copilot-probe-appendix.md)).

**The deny is a permission _ask_, not a hard block — and that ask enforces the
rail unless you run with `--allow-all-tools`.** Verified live:

- **Default / explicit `--allow-tool <tool>`** (even `--allow-tool edit`): the
  ask can't be answered headless, so it **defaults to deny and blocks the tool**,
  overriding the tool allowlist. The rail is protected.
- **`--allow-all-tools` / `--yolo`**: an allow-all override auto-approves the
  hook's ask, so the edit **proceeds** — the hook is neutered. **Do not run
  Copilot with `--allow-all-tools` if you want in-session rail protection** (the
  fleet adapter defaults to an explicit `--allow-tool` allowlist for this reason).
- **Crash / timeout**: no ask is raised → **fail-open**. The adapter never throws
  (internal errors convert to a deny, written synchronously to fd 1), so the only
  crash window is an OS-level kill or a blown `timeoutSec`.

**The unbypassable guarantee is the CI diff gate (`rails-guard-ci`)**, which
covers the `--allow-all-tools` and crash fail-open windows — treat it, not the
in-session hook, as the hard enforcement boundary.

The rail-decision logic is a verbatim port of the canonical `@adlc/core`
classifier; `test/shell-drift.test.mjs` pins it so there is no divergent
re-implementation.
