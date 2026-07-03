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
- Run the deterministic scaffolder to create `.adlc/config.json` (no clobber),
  wire `.cursor/hooks.json` + `.cursor/rules/adlc.mdc`, ensure `.gitignore`
  tracks the ticket + specs contracts, and exclude `.adlc/` from any detected
  repo formatter/linter:

  ```sh
  node "$(dirname "$(node -e "process.stdout.write(require.resolve('@adlc/cursor-package/package.json'))" 2>/dev/null || echo .)")/lib/scaffold-cli.mjs" .
  ```

  The scaffolder MERGES the ADLC `preToolUse` (rails-guard) and `afterFileEdit`
  (audit) entries into any existing `.cursor/hooks.json` without removing your
  other hooks.

## 3. Separate the contract from runtime evidence in git

Ensure `.gitignore` ignores all of `.adlc/` except the ticket contract and the
P1 specs contract:

```
.adlc/*
!.adlc/tickets.json
!.adlc/specs/
```

If an older two-line stanza exists (no `!.adlc/specs/`), add just that missing
line — the scaffolder above does this automatically (`ensureGitignore` in
`lib/scaffold.mjs`).

## 4. Exclude `.adlc/` from the repo's formatters and linters

`.adlc/tickets.json` is machine-written and, once a ticket declares `rails`,
becomes a frozen trust root that a reformat would trip `rails-guard` on. The
scaffolder's `ensureFormatterIgnores` detects and updates, only if already
present in the repo:

- **Biome** (`biome.json`) — merges an `overrides` entry disabling the
  formatter/linter for `.adlc/**`.
- **Prettier** (`.prettierignore`) — appends a `.adlc/` line.
- **ESLint** — adds `.adlc/**` to `ignorePatterns` in a JSON `.eslintrc*`, or
  appends `.adlc/` to `.eslintignore`. Flat `eslint.config.js`/`.mjs`/`.cjs` is
  only *detected*, not auto-edited; add `{ ignores: ['.adlc/**'] }` to the
  exported array manually.

If a repo uses a formatter/linter not covered here, document the manual
fallback: add a `.adlc/` (or `.adlc/**`) ignore/exclude entry to that tool's
config yourself before the first rails-bearing ticket is committed.

## 5. Preflight

Run `adlc preflight --json` and summarize the verdict (informational for setup).

## 6. Summarize

Report: toolkit version, whether `.adlc/tickets.json`/`config.json` were created or
already present, what was wired into `.cursor/`, gitignore changes, which
formatter/linter configs were updated (or need a manual entry), and the
preflight verdict. Remind the user that the in-session hook is **advisory** —
Cursor's `permission: "deny"` is best-effort — and that the unbypassable control
is the CI rail-freeze gate (`docs/ci/rails-guard.yml`).
