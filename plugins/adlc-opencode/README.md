# @adlc/opencode-package

ADLC ([Agentic Development Lifecycle](https://www.agenticlifecycle.ai)) integration for the
[OpenCode](https://opencode.ai) terminal coding agent: enforce-by-default rails guard,
lifecycle slash commands, prosecutor subagents, native skills, and a model-callable
`adlc_gate` tool that runs LLM-backed gates keyless through your session model.

## Install

```sh
# 1. The gate toolkit (the plugin shells out to the `adlc` binary)
npm install -g @adlc/cli

# 2. Bootstrap your project (registers the plugin, scaffolds .adlc/ + .opencode/)
npx @adlc/opencode-package init
```

Restart opencode. `/adlc-init` inside the TUI re-runs the same idempotent scaffold.

The bootstrap registers this package in `.opencode/opencode.json`'s `plugin` array;
opencode auto-installs it via Bun on next launch. When you run the bootstrap from a
source checkout instead of the npm package, the resolved local path is registered.

## Per-repo configuration

Plugin options can be passed with the tuple form in `opencode.json` (env vars
override options):

```json
{
  "plugin": [["@adlc/opencode-package", { "advisoryHooks": false, "ungatedTools": [] }]]
}
```

| Option | Env override | Effect |
| --- | --- | --- |
| `advisoryHooks: true` | `ADLC_ALLOW_ADVISORY_HOOKS=1` | Downgrade the rails guard from enforcing to advisory (explicit escape hatch) |
| `ungatedTools: [...]` | `ADLC_UNGATED_TOOLS=a,b` | Extra benign no-target tools exempt from gating (still spoof-guarded) |
| `suppressionEnforcement: true` | `ADLC_SUPPRESSION_ENFORCEMENT=1` | Enforce (not just warn on) unapproved suppression markers |
| `scopeEnforcement: true` | `ADLC_SCOPE_ENFORCEMENT=1` | Enforce (not just warn on) edits outside the active ticket's scope |

## Docs

Full integration guide: [docs/integrations/opencode.md](https://github.com/voodootikigod/adlc/blob/main/docs/integrations/opencode.md)
in the ADLC repo — commands, agents, gate coverage, threat model (ADR 0004), and CI backstops.

MIT © Chris Williams
