---
description: Bootstrap the ADLC runtime (.adlc/) and scaffold the Cursor hooks + rule.
---

# /adlc-init — bootstrap the ADLC workspace (Cursor)

Set up the shared `.adlc/` runtime every gate reads, scaffold the Cursor hooks
(the `preToolUse` dispatcher, the `afterFileEdit` audit, and the
`beforeShellExecution` advisory) and the gate-router rule into `.cursor/`, deploy
the `/adlc-*` command palette, and confirm the toolkit is reachable. Run once per
repository. Every step is idempotent — never clobber existing files.

## 1. Verify the toolkit

Run `adlc --version`. If not found, STOP and tell the user to install it:

```sh
npm install -g @adlc/cli
```

## 2. Runtime + Cursor wiring

- Create `.adlc/` if missing.
- If `.adlc/tickets.json` is absent, create it as `{ "tickets": [] }`. If present, leave it.
- Run the deterministic scaffolder to create `.adlc/config.json` (no clobber),
  wire `.cursor/hooks.json` + `.cursor/rules/adlc.mdc`, deploy the packaged
  `/adlc-*` command palette into `.cursor/commands/`, ensure `.gitignore`
  tracks the ticket + specs contracts, and exclude `.adlc/` from any detected
  repo formatter/linter:

  ```sh
  node "$(dirname "$(node -e "process.stdout.write(require.resolve('@adlc/cursor-package/package.json'))" 2>/dev/null || echo .)")/lib/scaffold-cli.mjs" .
  ```

  The scaffolder MERGES three ADLC hook entries into any existing
  `.cursor/hooks.json` without removing your other hooks:

  - `preToolUse` → the **dispatcher** (`adlc-pretool.mjs`): runs the rails
    decision first (a frozen-rail edit is denied verbatim) and only consults the
    advisory buildgate when rails allow **and** `ADLC_BUILD_GATE_ENFORCEMENT=1`
    (default-off, no unbypassable backstop). Exactly one `preToolUse` entry, so a
    second hook can never mask a rails deny.
  - `afterFileEdit` → the **audit + flail** notice (`adlc-audit.mjs`):
    observational only (Cursor's `afterFileEdit` cannot block).
  - `beforeShellExecution` → the **shell advisory** (`adlc-shell-advisory.mjs`):
    reminds the agent about rail writes; it never denies and is trivially
    bypassable.

  The `stop`-audit and `preflight` hooks are unverified Cursor events, so they
  ship **disabled**; opt in with `--wire-unpinned` (or
  `ADLC_CURSOR_WIRE_UNPINNED=1`).

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

`.adlc/tickets.json` is machine-written and is frozen as a rail trust root
whenever enforcement is active (`ADLC_P4_ENFORCEMENT=1` plus an active
ticket). A repo formatter that reformats it causes red quality checks and
diff churn on a file that must stay machine-canonical. (The in-session rail
hook does not see the formatter's write — formatters run out-of-band or via
shell, which is never gated in-session; the hook only advises against the
agent's own structured edits.) The scaffolder's `ensureFormatterIgnores`
detects and updates, only if already present in the repo:

- **Biome** (`biome.json`) — merges an `overrides` entry disabling the
  formatter/linter for `.adlc/**`.
- **Prettier** (`.prettierignore`) — appends a `.adlc/` line.
- **ESLint** — adds `.adlc/**` to `ignorePatterns` in a JSON `.eslintrc*`, or
  appends `.adlc/` to `.eslintignore`. Flat `eslint.config.js`/`.mjs`/`.cjs` is
  only *detected*, not auto-edited; add `{ ignores: ['.adlc/**'] }` to the
  exported array manually.

If a repo uses a formatter/linter not covered here, document the manual
fallback: add a `.adlc/` (or `.adlc/**`) ignore/exclude entry to that tool's
config yourself before enforcement is first switched on.

## 5. Preflight

Run `adlc preflight --json` and summarize the verdict (informational for setup).

## 6. Summarize

Report: toolkit version, whether `.adlc/tickets.json`/`config.json` were created or
already present, what was wired into `.cursor/` (hooks, rule, and the deployed
`.cursor/commands/` palette), gitignore changes, which formatter/linter configs
were updated (or need a manual entry), and the preflight verdict. Remind the
user that the in-session hook is **advisory** — Cursor's `permission: "deny"` is
best-effort — and that the unbypassable control is the CI rail-freeze gate
(`docs/ci/rails-guard.yml`). Point the user at `/adlc-ticket` to author their
first ticket.
