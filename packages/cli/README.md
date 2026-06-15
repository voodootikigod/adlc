# @adlc/cli

The umbrella **dispatcher** for the [ADLC](https://github.com/voodootikigod/adlc)
suite. One install, one stable `adlc <tool>` command surface for all 19 ADLC
CLIs.

## Why this exists

The 19 `@adlc/*` tools each publish independently and can be installed and run
on their own. But a *harness* (Claude Code hooks, CI gates, the integration
plugin) needs a **single, stable command** to shell out to — not twenty separate
bins resolved at twenty separate paths. `@adlc/cli`:

- installs the whole suite in one step (it depends on every tool), and
- gives every hook and command the same prefix — `adlc <tool> …` — which is
  also prompt-cache friendly (a stable command string).

It is a *router*. It adds no behavior of its own to a tool's run: argv is
forwarded verbatim and the tool's exit code is propagated unchanged.

## Install

```sh
npm install -g @adlc/cli     # installs adlc + all 19 tools
```

## Usage

```sh
adlc <tool> [args...]   # run a tool — everything after <tool> passes through
adlc <tool> --help      # help for a specific tool
adlc --help             # list every tool, grouped by ADLC cluster
adlc --version          # dispatcher version
```

Examples:

```sh
adlc spec-lint spec.md --prompt-only
adlc preflight --json
adlc rails-guard --base main --ticket T-12
```

## Exit codes

The dispatcher mirrors the tool's exit code, so it works as a CI/hook gate
exactly like the underlying CLI:

- `0` — gate passes (or the command completed successfully).
- `1` — operational error: bad input, **or the tool is not installed**, or a
  spawn failure. The dispatcher never returns `0` for an internal failure, so a
  broken dispatch cannot silently pass a gate.
- `2` — gate fails (a material issue the tool wants blocked or reviewed).

`adlc --help` / `adlc --version` exit `0`. An unknown tool name exits `1` (with a
"did you mean" suggestion). Only a **bare** `--help` / `--version` is the
dispatcher's — once a tool name is present, every following flag (including
`--help`) is forwarded to the tool.

## ADLC phase

Cross-cutting. The dispatcher serves no single phase; it is the delivery and
invocation layer that the harness integration (hooks, slash commands, skills)
builds on. See [`docs/claude-code-integration-plan.md`](../../docs/claude-code-integration-plan.md).

## Relationship to sibling tools

`@adlc/cli` depends on all 19 CLIs and resolves each tool's declared `bin` at
run time from its installed `package.json`. It deliberately does **not**
re-implement any tool logic — adding a tool to the suite means adding it to
`lib/registry.mjs` and to this package's dependencies.
