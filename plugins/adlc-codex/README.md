# `@adlc/codex`

Native Codex plugin for the Agentic Development Lifecycle. It bundles skills,
trusted lifecycle hooks, an allowlisted MCP declaration, and project-agent templates.

## Install

ADLC publishes `@adlc/cli` and `@adlc/codex` in one lockstep release. Use
`@adlc/cli` 1.4.2 or newer so the MCP transport can launch `adlc mcp-server`.
Codex installs the plugin itself through its Git marketplace:

```sh
npm install -g @adlc/cli@latest
codex plugin marketplace add voodootikigod/adlc --ref main
codex plugin add adlc-codex@adlc
adlc init --root /absolute/path/to/project
```

Start a new Codex session in the initialized project, then review and trust the
plugin hooks.

The plugin launches its MCP server through `adlc mcp-server`. Keep the matching
`@adlc/cli` release installed globally and available on the `PATH` inherited by
Codex. This stable CLI entrypoint preserves the active project directory and does
not depend on plugin-root placeholder expansion.

Update the CLI and plugin together:

```sh
npm install -g @adlc/cli@latest
codex plugin marketplace upgrade adlc
codex plugin add adlc-codex@adlc
```

Start a new Codex thread after reinstalling so it picks up the refreshed MCP
transport. Remove with `codex plugin remove adlc-codex@adlc`.

## Develop from a checkout

For local plugin development, install the CLI from the same checkout and
register that checkout as the marketplace source:

```sh
git clone https://github.com/voodootikigod/adlc.git
cd adlc
npm install --ignore-scripts
npm install -g ./packages/cli
adlc init --root /absolute/path/to/project
codex plugin marketplace add "$PWD"
codex plugin add adlc-codex@adlc
```
