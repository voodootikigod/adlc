---
description: Bootstrap the ADLC runtime (.adlc/) and scaffold the Cursor hooks + rule.
---

# /adlc-init — bootstrap the ADLC workspace (Cursor)

Set up the shared `.adlc/` runtime every gate reads, scaffold the Cursor
`preToolUse`/`afterFileEdit` hooks and the gate-router rule into `.cursor/`, and
confirm the toolkit is reachable. Run once per repository. Every step is
idempotent — never clobber existing files.

## 1. Verify the toolkit

Run `adlc --version`. If not found, STOP and tell the user to install it:

```sh
npm install -g @adlc/cli
```

## 2. Runtime + Cursor wiring

- Create `.adlc/` if missing.
- If `.adlc/tickets.json` is absent, create it as `{ "tickets": [] }`. If present, leave it.
- Run the deterministic scaffolder to create `.adlc/config.json` (no clobber) and
  wire `.cursor/hooks.json` + `.cursor/rules/adlc.mdc`:

  ```sh
  node "$(dirname "$(node -e "process.stdout.write(require.resolve('@adlc/cursor-package/package.json'))" 2>/dev/null || echo .)")/lib/scaffold-cli.mjs" .
  ```

  The scaffolder MERGES the ADLC `preToolUse` (rails-guard) and `afterFileEdit`
  (audit) entries into any existing `.cursor/hooks.json` without removing your
  other hooks.

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
already present, what was wired into `.cursor/`, gitignore changes, and the
preflight verdict. Remind the user that the in-session hook is **advisory** —
Cursor's `permission: "deny"` is best-effort — and that the unbypassable control
is the CI rail-freeze gate (`docs/ci/rails-guard.yml`).
