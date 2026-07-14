# Codex Integration

ADLC installs as a native Codex plugin with six skills, hooks across eight
lifecycle events, two MCP tools, and three project-agent templates. The plugin
reads and writes the same `.adlc/` evidence as every other harness integration.

## Install from the current source

```sh
git clone https://github.com/voodootikigod/adlc.git
cd adlc
npm install --ignore-scripts
npm install -g @adlc/cli
node packages/init/bin/adlc-init.mjs --root /absolute/path/to/project
codex plugin marketplace add "$PWD"
codex plugin add adlc-codex@adlc
```

The checkout initializer creates the committable `.adlc/` runtime and
`.codex/agents/adlc-{explorer,reviewer,verifier}.toml`. It is idempotent,
preserves existing files, and never changes `~/.codex`.

This revision makes `@adlc/init` and the umbrella dispatch release-ready; it
does not publish them. Do not assume an older registry release contains `adlc
init`. Start a new Codex session in the target project and trust the bundled
hooks when prompted. Until the matching release exists, rerun the checkout
initializer to refresh; `$adlc-init` becomes available with that release.

Once a matching suite release is published, the shorter flow is:

```sh
npm install -g @adlc/cli
codex plugin marketplace add voodootikigod/adlc --ref main
codex plugin add adlc-codex@adlc
adlc init --root /absolute/path/to/project
```

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
- `$adlc-prosecute` handles P5 review evidence and P6 acceptance.
- `$adlc-distill` handles P7 compounding defenses.
- `$adlc-init` safely bootstraps the project runtime.

The MCP server exposes `adlc_gate` and `adlc_prosecute`. `adlc_gate` accepts a
small read-only gate allowlist, requires `--prompt-only` for generative gates,
rejects mutating, nested-command, provider, and path-escape arguments, and
invokes the CLI without a shell. `adlc_prosecute` is separated because it is an
explicit evidence-producing workflow rather than an incidental read-only gate.

Codex automatically discovers the standalone project roles under
`.codex/agents/*.toml`; no `[agents]` registration is added to a user's global
configuration.

## Hooks and rails

The plugin registers SessionStart, PreToolUse, PostToolUse, PreCompact,
PostCompact, SubagentStart, SubagentStop, and Stop hooks using Codex's
`PLUGIN_ROOT` and `PLUGIN_DATA` variables.

The `PreToolUse` rail guard automatically activates when
`.adlc/current-ticket.json` selects an incomplete ticket with non-empty rails.
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
codex plugin marketplace upgrade adlc
codex plugin list --json --available
codex plugin remove adlc-codex@adlc
```

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
