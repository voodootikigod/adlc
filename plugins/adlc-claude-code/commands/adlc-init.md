---
description: Bootstrap the ADLC runtime (.adlc/) in this repo and verify the toolkit is installed.
argument-hint: (no arguments)
---

# /adlc:adlc-init — bootstrap the ADLC workspace

Set up the shared `.adlc/` runtime that every ADLC gate reads and writes, and
confirm the gate toolkit is reachable. Run this once per repository.

Do the following, in order, and report a concise summary at the end. Treat each
step as idempotent — never clobber an existing ticket file.

## 1. Verify the toolkit is installed

Run `adlc --version`.

- If it prints a version, the suite is installed — continue.
- If the command is **not found**, STOP and tell the user to install it first:
  ```sh
  npm install -g @adlc/cli
  ```
  Do not attempt to install it for them globally without their say-so. Once they
  confirm it is installed, re-run this command.

## 2. Initialize or migrate ticket storage

- Run `adlc ticket store status --json`.
- If no store exists, initialize through the installed ADLC scaffolder; new
  repositories use `.adlc/tickets/` and `.adlc/ticket-archive/` manifests.
- If legacy `.adlc/tickets.json` exists, preview with
  `adlc ticket store migrate`. Show the representation-only plan and ask the
  human `Apply migration? [y/N]`. Only after approval run
  `adlc ticket store migrate --write --yes`. A decline leaves the legacy file
  fully operational. Never prompt or migrate in non-interactive/JSON mode.
- Never edit shards directly, stage files, commit, or create backup files.

## 3. Separate the contract from the runtime evidence in git

The ticket file and the P1 specs are the **source-of-truth contracts** between
tools and are worth committing. Everything else under `.adlc/` — append-only
ledgers, gate evidence, the ticket lock, and hook runtime state — is a
**runtime artifact** and should not be. If a `.gitignore` exists (create one if
it does not), ensure it ignores all of `.adlc/` *except* the ticket file and the
specs directory — add these three lines if absent:

```
.adlc/*
!.adlc/tickets.json
!.adlc/tickets/
!.adlc/tickets/**
!.adlc/ticket-archive/
!.adlc/ticket-archive/**
!.adlc/specs/
```

These negations keep `tickets.json` and `.adlc/specs/` (the P1 spec for every
ticket — arguably the most important contract in the lifecycle) tracked while
ignoring all current and future runtime files (ledgers, `lessons/`,
`tickets.lock/`, …) without you having to enumerate them. If the repo already
has a blanket `.adlc/` ignore (which would also hide `tickets.json` and
`specs/`), point that out and ask the user whether they want to track them
(recommended) before changing it. If `.gitignore` already has the older
two-line form (`.adlc/*` + `!.adlc/tickets.json` but no `!.adlc/specs/`), add
just the missing `!.adlc/specs/` line — don't touch anything else.

## 4. Exclude `.adlc/` from the repo's formatters and linters

The ticket store is machine-written. Once any ticket declares `rails`, the active store becomes a
**frozen trust root** — it cannot be reformatted on a ticket branch without
tripping `rails-guard`. A repo formatter/linter that reformats it will silently
break the next PR. Check for the following configs and, only for the ones that
already exist in this repo, add an `.adlc/` exclusion:

- **Biome** (`biome.json`): add an override that disables the formatter and
  linter for the directory:
  ```json
  {
    "overrides": [
      { "include": [".adlc/**"], "formatter": { "enabled": false }, "linter": { "enabled": false } }
    ]
  }
  ```
  Merge this into any existing `overrides` array — do not replace it.
- **Prettier** (`.prettierignore`): append a `.adlc/` line.
- **ESLint**: for a JSON `.eslintrc`/`.eslintrc.json`, add `.adlc/**` to
  `ignorePatterns`. For an `.eslintignore` file, append a `.adlc/` line. For a
  flat `eslint.config.js`/`.mjs`/`.cjs`, do not attempt an automated text edit —
  report it and tell the user to add `{ ignores: ['.adlc/**'] }` to the
  exported config array themselves.

Only touch a config file that is already present — never create a new
formatter/linter config just to add this exclusion. If none of these configs
exist, or the repo uses a formatter/linter not listed here (e.g. StandardJS,
Ruff, golangci-lint), say so explicitly and document the manual fallback: add
a `.adlc/` (or `.adlc/**`) ignore/exclude entry to that tool's config yourself
before the first ticket with `rails` is committed.

## 5. Run a preflight check

Run `adlc preflight --json` and summarize the verdict. This surfaces missing
tools, a dirty tree, or provider problems before any work fans out. A non-zero
exit here is informational for setup — report it, do not treat it as a failure of
this command.

## 6. Summarize

Report: toolkit version, the active backend, whether a legacy migration was
accepted or declined, what was added to `.gitignore`, which formatter/linter
configs (if any) were updated to exclude `.adlc/` and which need a manual entry,
and the preflight verdict. Then point the user at `/adlc:adlc-ticket` to author
their first ticket (P0), and note that the `adlc` discovery skill will route
them through the rest of the lifecycle.
