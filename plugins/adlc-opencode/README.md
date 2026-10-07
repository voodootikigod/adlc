# @adlc/opencode

ADLC ([Agentic Development Lifecycle](https://www.agenticlifecycle.ai)) integration for the
[OpenCode](https://opencode.ai) terminal coding agent: enforce-by-default rails guard,
lifecycle slash commands, prosecutor subagents, native skills, and a model-callable
`adlc_gate` tool that runs LLM-backed gates keyless through your session model.

## Install

Requires **OpenCode >= 2.0.20** — the plugin targets the OpenCode v2 plugin API
only (default export `{ id: "adlc", setup(ctx) }`). OpenCode 1.x cannot load it.

```sh
# 1. The gate toolkit (the plugin shells out to the `adlc` binary)
npm install -g @adlc/cli

# 2. Bootstrap your project (registers the plugin, scaffolds .adlc/ + .opencode/)
npx @adlc/opencode init
```

Restart opencode. `/adlc-init` inside the TUI re-runs the same idempotent scaffold.
It never overwrites an existing `.adlc/config.json`; if that file is not a JSON
object, the scaffold says so and exits non-zero instead of reporting it present.

A gate run through `adlc_gate` that timed out or was killed by a signal returns
`exitCode: null` and a "did not complete" error, never an exit code. Every `git` and
`adlc` child the in-process session hooks and the `filesystem.changed` watcher spawn is bounded
(5 s, SIGKILL), so a wedged child cannot freeze opencode.

The bootstrap registers this package in `.opencode/opencode.json`'s v2 `"plugins"`
array, and migrates an existing v1 `"plugin"` entry for it (options kept);
OpenCode installs package entries from npm on next launch. When you run the
bootstrap from a source checkout instead of the npm package, the resolved local
package directory is registered.

## Per-repo configuration

Plugin options ride the object form of the `plugins` entry in `opencode.json`
(env vars override options):

```json
{
  "plugins": [
    { "package": "@adlc/opencode", "options": { "advisoryHooks": false, "ungatedTools": [] } }
  ]
}
```

| Option | Env override | Effect |
| --- | --- | --- |
| `advisoryHooks: true` | `ADLC_ALLOW_ADVISORY_HOOKS=1` | Downgrade the rails guard from enforcing to advisory (explicit escape hatch) |
| `ungatedTools: [...]` | `ADLC_UNGATED_TOOLS=a,b` | Extra benign no-target tools exempt from gating (still spoof-guarded) |
| `suppressionEnforcement: true` | `ADLC_SUPPRESSION_ENFORCEMENT=1` | Enforce (not just warn on) unapproved suppression markers |
| `scopeEnforcement: true` | `ADLC_SCOPE_ENFORCEMENT=1` | Enforce (not just warn on) edits outside the active ticket's scope |

## Notices and known gaps

There is no toast channel for v2 server plugins, so statusline, preflight,
audit and advisory notices and denials are written to the OpenCode server's
stderr as `[adlc] <level>: <message>`; a denial also reaches the model as the
tool error. `opencode run --standalone --print-logs` shows them. On 2.0.20 the
background service's log file (the `log` path from `opencode debug paths`) does
not include them.

- **No TUI toasts** (above).
- **Autocontinue not ported:** v2 has no `compaction.autocontinue` hook. After
  compaction, a high-risk ticket's next structured edit is denied by the build
  gate instead.
- **Rail notice fixed at load:** the rail notice in the edit/write/patch tool
  descriptions reflects the ticket active when OpenCode loaded its tools.
- **permission.evaluate: dispatched**, after `execute.before`; the
  `execute.before` throw is the enforcing control.
- **Lens child sessions are not removed** after `adlc_prosecute` (no session
  delete in the v2 plugin API); keyless gates use `ctx.generate.text`.
- **Code Mode `execute` is denied while rails are in force** (its code has no
  vettable target).

## Docs

Full integration guide: [docs/integrations/opencode.md](https://github.com/voodootikigod/adlc/blob/main/docs/integrations/opencode.md)
in the ADLC repo — commands, agents, gate coverage, threat model (ADR 0004), and CI backstops.

MIT © Chris Williams
