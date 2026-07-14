# `@adlc/codex`

Native Codex plugin for the Agentic Development Lifecycle. It bundles skills,
trusted lifecycle hooks, an allowlisted local MCP server, and project-agent templates.

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

Start a new Codex session in the initialized project, then review and trust the
plugin hooks.

This checkout adds `adlc init`, but does not publish it. Until a matching suite
release exists, rerun the checkout initializer to refresh the scaffold rather
than invoking `$adlc-init` against an older global CLI.

After the matching release, the native Git marketplace flow is:

```sh
npm install -g @adlc/cli
codex plugin marketplace add voodootikigod/adlc --ref main
codex plugin add adlc-codex@adlc
```

Update with `codex plugin marketplace upgrade adlc`. Remove with
`codex plugin remove adlc-codex@adlc`.

The npm package is release-ready but is not yet documented as published.
