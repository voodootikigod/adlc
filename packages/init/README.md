# `@adlc/init`

Idempotently bootstrap the committable `.adlc/` runtime and the project-scoped
`.codex/agents/` roles used by the native Codex integration.

From the current checkout (before the matching suite release):

```sh
node packages/init/bin/adlc-init.mjs --root /path/to/repo
```

After the matching `@adlc/cli` release:

```sh
adlc init
adlc init --root /path/to/repo --json
```

The initializer preserves existing files, refuses symlink escapes from the
project root, and never edits user-global `~/.codex` implicitly.
