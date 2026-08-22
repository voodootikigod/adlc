# Codex Integration

ADLC installs as a native Codex plugin with six skills, hooks across eight
lifecycle events, two MCP tools, and nine project-agent templates. The plugin
reads and writes the same `.adlc/` evidence as every other harness integration.

## Install

ADLC releases the CLI and Codex plugin package in lockstep. Use `@adlc/cli`
1.11.0 or newer: the context-rot handoff gate hard-requires
`@adlc/context-handoff` exports that first ship in 1.11.0 and fails closed below
it, denying every structured edit and mutating shell command. (1.4.2 or newer is
what makes the `adlc mcp-server` entrypoint available; the handoff gate is the
binding constraint.) Codex installs the native plugin through its Git
marketplace; installing `@adlc/codex` with npm alone does not register the
plugin with Codex.

```sh
npm install -g @adlc/cli@latest
codex plugin marketplace add voodootikigod/adlc --ref main
codex plugin add adlc-codex@adlc
adlc init --root /absolute/path/to/project
```

The initializer creates the committable `.adlc/` runtime and
`.codex/agents/adlc-{explorer,reviewer,verifier}.toml` plus the six P5
prosecution agents,
`.codex/agents/adlc-prosecutor-{correctness,security,contract,diff,tests,verifier}.toml`.
It is idempotent, preserves existing files, and never changes `~/.codex`. Start
a new Codex thread after installation and trust the bundled hooks when
prompted.

An older plugin installed through the compatibility marketplace can surface a
`PostToolUse hook exited with code 1` error from its translator. Replace it with
the native bundle:

```sh
codex plugin remove adlc@plugins-cli
codex plugin add adlc-codex@adlc
```

## Use

- `$adlc` routes a task to the correct lifecycle gate.
- `$adlc-spec` handles P1–P2 shaping and decomposition.
- `$adlc-rail-build` handles frozen rails and P4 supervision.
- `$adlc-prosecute` runs the P5 multi-lens adversarial fan-out (five
  independent read-only lenses, cross-lens dedupe, independent verification,
  loop until dry) and handles P5 review evidence and P6 acceptance.
- `$adlc-distill` handles P7 compounding defenses.
- `$adlc-init` safely bootstraps the project runtime.

The MCP server exposes `adlc_gate` and `adlc_prosecute`. `adlc_gate` accepts a
small read-only gate allowlist, requires `--prompt-only` for generative gates,
rejects mutating, nested-command, provider, and path-escape arguments, and
invokes the CLI without a shell. `adlc_prosecute` is separated because it is an
explicit evidence-producing workflow rather than an incidental read-only gate.
The transport launches `adlc mcp-server` in the active project and does not rely
on plugin-root placeholder expansion.

Codex automatically discovers the standalone project roles under
`.codex/agents/*.toml`; no `[agents]` registration is added to a user's global
configuration.

## Hooks and rails

The plugin registers SessionStart, PreToolUse, PostToolUse, PreCompact,
PostCompact, SubagentStart, SubagentStop, and Stop hooks using Codex's
`PLUGIN_ROOT` and `PLUGIN_DATA` variables.

The `PreToolUse` rail guard automatically activates when
`.adlc/current-ticket.json` selects an incomplete ticket with non-empty rails
(that file's schema and read semantics: [the active-ticket pointer](../active-ticket-pointer.md)).
`ADLC_TICKET` is an explicit ticket override. `ADLC_P4_ENFORCEMENT=1` forces
enforcement; `ADLC_P4_ENFORCEMENT=0` is a deliberate local opt-out. Conflicting
ticket selectors and stale active state fail closed once enforcement is active.

Hooks provide immediate feedback but are not a complete security boundary.
Keep `scripts/rails-guard-ci.mjs` as a required repository check; it validates
the committed diff against rails read from the trusted base ref.

The `PostToolUse` hook only records repeated failure signatures in
`PLUGIN_DATA`. Internal hook errors are caught and reported as an advisory
`systemMessage`; the hook exits zero so it cannot turn a successful Codex tool
call into a failure.

## Update and remove

```sh
npm install -g @adlc/cli@latest
codex plugin marketplace upgrade adlc
codex plugin add adlc-codex@adlc
codex plugin list --json --available
codex plugin remove adlc-codex@adlc
```

Upgrade the CLI and marketplace plugin together, then start a new Codex thread
so the refreshed MCP transport is loaded.

## Verification

```sh
# Offline manifest, payload, hook, skill, agent, and MCP contract
node scripts/codex-install-smoke.mjs .

# Real marketplace add/install in disposable home and cache roots
ADLC_CODEX_LIVE_INSTALL=1 node scripts/codex-install-smoke.mjs .
```

The live proof verifies installed-cache hook execution, starts the MCP server
from the installed plugin declaration, makes a successful MCP tool call, and
confirms the user's real home is unchanged. CI runs the offline proof on every test job, the live proof
against a pinned Codex version in the required Node 22 leg, and an advisory
latest-version canary.

See [ADR 0001](../adr/0001-codex-native-adlc-integration.md) for the original
design rationale and [ticket authoring](../ticket-authoring.md) for the shared
ticket contract.
