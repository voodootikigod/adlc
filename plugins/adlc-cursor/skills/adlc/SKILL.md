---
name: adlc
description: >-
  Route software work through the Agentic Development Lifecycle in Cursor.
  Use when the user asks to apply ADLC, operate in ADLC, triage work, choose
  the next ADLC gate, or mentions P0–P7 / rails / prosecute.
---

<!-- ADLC_CURSOR_SENTINEL_PHASE_ROUTER_V1 -->

# ADLC — phase routing (Cursor)

Treat agentic development as phases with machine-checkable gates via
`adlc <tool>` (exit 0 = pass, 1 = operational error, 2 = gate fail).

Prerequisite: `adlc --version` works (`npm i -g @adlc/cli`). Run `/adlc-init`
or `adlc init --harness cursor` once per repo for the `.adlc/` workspace.

## Where am I? → which gate

```
Vague request, no ticket yet? ───────────────→ P0  /adlc-ticket
Have a spec / acceptance criteria? ──────────→ P1  /adlc-spec · /adlc-approve-spec
Have tickets, planning fan-out? ─────────────→ P2  /adlc-decompose
About to build, want to freeze tests? ───────→ P3  rails-guard hooks + CI
Mid-build / verify? ─────────────────────────→ P4  /adlc-verify-build
Change done, pre-merge prosecution? ─────────→ P5  /adlc-prosecute
Repeated review findings to bank? ───────────→ P7  /adlc-distill
Idle-time maintenance? ──────────────────────→ —   /adlc-maintain
```

LLM-backed gates support `--prompt-only`: print the prompt, answer it yourself
in-session (no API keys). Prefer that over wiring providers.

**Enforcement honesty:** Cursor `preToolUse` deny is best-effort. The
unbypassable control is the CI rail-freeze gate (`docs/ci/rails-guard.yml`).

**MCP tools (packaged):** the plugin ships `mcp.json`, which asks Cursor to
expand `${CURSOR_PLUGIN_ROOT}` and launch a bundled lifecycle Roots proxy. The
launcher needs no plugin-cache `node_modules`. Cursor Desktop 3.20.10 live
proof confirms expansion in `args` and `cwd`, bundle boot, and a `roots/list`
response carrying a bare absolute-path `uri`; the proxy accepts that form and
`file://` URIs. The post-fix run bound, exposed `adlc_gate` and
`adlc_prosecute`, and `adlc_gate gate-manifest show` returned `ok` with
`exitCode: 0`. It spawns `adlc mcp-server` only after resolving a consumer
root. Requires a global `@adlc/cli` installation resolvable by Cursor's
Node/npm environment (`npm i -g @adlc/cli`), without launching a Windows
`.cmd` shim. Rebind and live multi-root refusal remain unverified — do not treat
MCP as production-shipped. Never guess
`process.cwd()`; multi-root ambiguity fails closed.

**P5 caveat:** prefer Task fan-out via packaged `agents/prosecutor-*` (fresh
context per lens). Sequential same-context is a **degraded fallback** with
weaker independence. For the cross-model risk gate run
`npx adversarial-review --providers <a,b>`.
