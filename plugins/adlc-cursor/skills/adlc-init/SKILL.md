---
name: adlc-init
description: >-
  Initialize or refresh ADLC for Cursor. Use for first-time setup, bootstrap
  `.adlc/`, repair missing runtime config, or re-run the legacy scaffolder.
---

<!-- ADLC_CURSOR_SENTINEL_INIT_V1 -->

# Initialize ADLC for Cursor

## Preferred (marketplace plugin already installed)

1. Confirm the toolkit: `adlc --version` (else `npm install -g @adlc/cli`).
2. Run `adlc init --harness cursor --json` from the repository root.
3. Confirm `.adlc/config.json` and `.adlc/specs/` exist.
4. Run `adlc preflight --json` and report readiness.
5. Remind the user: in-session rails hooks are advisory; wire
   `docs/ci/rails-guard.yml` as a required check.

## Legacy / local-dev fallback (no marketplace plugin)

If the user still wants project-copied `.cursor/` files:

```sh
npx @adlc/cursor .
```

Or from a source checkout:

```sh
node "$(dirname "$(node -e "process.stdout.write(require.resolve('@adlc/cursor/package.json'))" 2>/dev/null || echo .)")/lib/scaffold-cli.mjs" .
```

The scaffolder is idempotent. It merges hooks (including `stop` /
`beforeSubmitPrompt` by default; opt out with `--no-unpinned`) and deploys
`/adlc-*` commands. Prefer marketplace install so hooks/skills update with the
plugin instead of copied project files.
