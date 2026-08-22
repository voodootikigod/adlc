# `@adlc/codex`

Native Codex plugin for the Agentic Development Lifecycle. It bundles skills,
trusted lifecycle hooks, an allowlisted MCP declaration, and project-agent templates.

## Install

ADLC publishes `@adlc/cli` and `@adlc/codex` in one lockstep release. Use
`@adlc/cli` **1.11.0 or newer**: the context-rot handoff gate hard-requires
`@adlc/context-handoff` exports that first ship in 1.11.0 and fails closed below
it, denying every structured edit and mutating shell command. (Secondarily,
1.4.2 or newer is what lets the MCP transport launch `adlc mcp-server`; the
handoff gate is the binding constraint.) Codex installs the plugin itself
through its Git marketplace:

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

## Context-rot handoff gate

The plugin's `adlc-handoff-gate` hook runs on every tool call. Once the session
crosses the deny band, it denies structured edits and mutating shell commands
until the work is handed off to a fresh session, so a context-degraded session
cannot keep writing.

A deny that reads `@adlc/context-handoff missing export: … the resolved install
is too old for this plugin` is not the deny band firing — it is the version
check failing closed, and it denies everything regardless of session depth.
Upgrade the CLI:

```sh
npm install -g @adlc/cli@latest
```

That check runs before any bypass grant is consulted, so a grant cannot rescue a
version mismatch. Upgrading is the only way out.

For a genuine deny-band stop, the recovery path is a one-shot bypass grant:

```sh
adlc handoff bypass --session <id> --write
```

Run it from the host shell with `ADLC_MANIFEST_KEY` set — the grant is verified
against that key and authorizes exactly one mutation. The deny message prints
the exact command, with the session id already filled in, that the gate will
accept from inside the session.

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
