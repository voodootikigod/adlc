---
description: Bootstrap the ADLC runtime (.adlc/) and scaffold the OpenCode command/skill surface.
---

# /adlc-init — bootstrap the ADLC workspace (OpenCode)

Set up the shared `.adlc/` runtime every gate reads, scaffold this plugin's
commands and skill into `.opencode/`, and confirm the toolkit is reachable. Run
once per repository. Every step is idempotent — never clobber existing files.

## 1. Verify the toolkit

Run `adlc --version`. If not found, STOP and tell the user to install it:

```sh
npm install -g @adlc/cli
```

## 2. Runtime + config

- Create `.adlc/` if missing.
- If `.adlc/tickets.json` is absent, create it as `{ "tickets": [] }`. If present, leave it.
- Run the deterministic scaffolder to create `.adlc/config.json` (defaults, no
  clobber) and deploy this plugin's `command/` and `skill/` into `.opencode/`:

  !`node "$(dirname "$(node -e "process.stdout.write(require.resolve('@adlc/opencode-package/package.json'))" 2>/dev/null || echo .)")/lib/scaffold-cli.mjs" .`

  (If the helper is unavailable, scaffold manually: create `.adlc/config.json`
  with `{"securityMode":"unsigned-fallback"}` and copy the plugin's `command/*.md`
  into `.opencode/commands/` and `skill/*.md` into `.opencode/skill/`.)

## 3. Separate the contract from runtime evidence in git

Ensure `.gitignore` ignores all of `.adlc/` except the ticket contract:

```
.adlc/*
!.adlc/tickets.json
```

## 4. Preflight

Run `adlc preflight --json` and summarize the verdict (informational for setup).

## 5. Summarize

Report: toolkit version, whether `.adlc/tickets.json`/`config.json` were created or
already present, what was deployed into `.opencode/`, gitignore changes, and the
preflight verdict. Point the user at `/adlc-ticket` to author their first ticket.
