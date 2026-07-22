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
`{"reason":"…"}` on stdout (the deny shape verified against Copilot CLI 1.0.73 —
see [`docs/integrations/copilot-probe-appendix.md`](../../docs/integrations/copilot-probe-appendix.md)).

**Copilot hooks fail _open_ on a crashed/timed-out hook process** (a failed hook
yields no decision, so the tool proceeds). This adapter mitigates that by never
throwing to the OS — any internal error is converted into a deny
(application-level fail-safe) — but an OS-level kill or a blown `timeoutSec`
budget is a genuine fail-open window. **Therefore the in-session hook is
advisory-tier; the unbypassable rail guarantee is the CI diff gate**
(`rails-guard-ci`), the same backstop ADLC uses for shell-driven edits. Do not
treat the in-session hook as the enforcement boundary.

The rail-decision logic is a verbatim port of the canonical `@adlc/core`
classifier; `test/shell-drift.test.mjs` pins it so there is no divergent
re-implementation.
