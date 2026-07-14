# `adlc init`

This command is implemented in the current source but is not in the older
registry release. From a checkout, run
`node packages/init/bin/adlc-init.mjs`; use the umbrella command below after the
matching suite release is published.

Idempotently creates the committable `.adlc/` runtime and the current
project-scoped Codex agent roles.

```sh
adlc init [--root <path>] [--json] [--no-codex-agents]
```

The initializer writes only below `--root`, preserves existing files, and does
not modify `~/.codex` or another user-global harness configuration. `$adlc-init`
in the native Codex plugin delegates to this command.
