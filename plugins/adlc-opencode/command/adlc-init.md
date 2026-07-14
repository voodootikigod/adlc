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
- Let the deterministic scaffolder initialize the sharded active/archive stores.
  If legacy `.adlc/tickets.json` exists, preview `adlc ticket store migrate`,
  ask the human, and apply only after approval with `--write --yes`; decline
  leaves the legacy backend fully operational.
- Run the deterministic scaffolder to create `.adlc/config.json` (defaults, no
  clobber), deploy this plugin's `command/`, `agent/`, and `skill/` into
  `.opencode/` (commands/, agents/, skills/<name>/SKILL.md), ensure `.gitignore`
  tracks the ticket + specs contracts, and exclude `.adlc/` from any detected
  repo formatter/linter:

  !`node "$(dirname "$(node -e "process.stdout.write(require.resolve('@adlc/opencode/package.json'))" 2>/dev/null || echo .)")/lib/scaffold-cli.mjs" .`

  (If the helper is unavailable, scaffold manually: create `.adlc/config.json`
  with `{"securityMode":"unsigned-fallback"}`, copy the plugin's `command/*.md`
  into `.opencode/commands/`, `agent/*.md` into `.opencode/agents/`, and each
  `skill/<name>.md` to `.opencode/skills/<name>/SKILL.md`, then do steps 3 and 4
  below by hand.)

## 3. Separate the contract from runtime evidence in git

Ensure `.gitignore` ignores all of `.adlc/` except the ticket contract and the
P1 specs contract:

```
.adlc/*
!.adlc/tickets.json
!.adlc/tickets/
!.adlc/tickets/**
!.adlc/ticket-archive/
!.adlc/ticket-archive/**
!.adlc/specs/
```

If an older two-line stanza exists (no `!.adlc/specs/`), add just that missing
line — the scaffolder above does this automatically (`ensureGitignore` in
`lib/scaffold.mjs`).

## 4. Exclude `.adlc/` from the repo's formatters and linters

The active ticket store is machine-written and, once a ticket declares `rails`,
becomes a frozen trust root that a reformat would trip `rails-guard` on. The
scaffolder's `ensureFormatterIgnores` detects and updates, only if already
present in the repo:

- **Biome** (`biome.json`) — merges an `overrides` entry disabling the
  formatter/linter for `.adlc/**`.
- **Prettier** (`.prettierignore`) — appends a `.adlc/` line.
- **ESLint** — adds `.adlc/**` to `ignorePatterns` in a JSON `.eslintrc*`, or
  appends `.adlc/` to `.eslintignore`. Flat `eslint.config.js`/`.mjs`/`.cjs` is
  only *detected*, not auto-edited (it's executable JS); add
  `{ ignores: ['.adlc/**'] }` to the exported array manually.

If a repo uses a formatter/linter not covered here, or the scaffolder is
unavailable, document the manual fallback: add a `.adlc/` (or `.adlc/**`)
ignore/exclude entry to that tool's config yourself before the first
rails-bearing ticket is committed.

## 5. Preflight

Run `adlc preflight --json` and summarize the verdict (informational for setup).

## 6. Summarize

Report: toolkit version, the ticket backend/migration decision and whether `config.json` was created or
already present, what was deployed into `.opencode/`, gitignore changes, which
formatter/linter configs were updated (or need a manual entry), and the
preflight verdict. Point the user at `/adlc-ticket` to author their first ticket.
