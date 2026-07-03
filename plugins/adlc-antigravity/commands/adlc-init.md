---
name: adlc-init
description: Bootstrap ADLC in this repo for Antigravity — install the plugin into agy and scaffold .adlc/.
---

# /adlc-init (Antigravity)

Bootstrap the ADLC runtime for use with `agy`.

1. **Install this plugin into agy** (idempotent):
   ```sh
   agy plugin install /absolute/path/to/plugins/adlc-antigravity
   agy plugin list   # confirm "adlc-antigravity" with a "hooks" component
   ```
2. **Initialize the ADLC workspace** (creates `.adlc/`, requires `npm i -g @adlc/cli`):
   ```sh
   adlc init || npx @adlc/cli init
   ```
3. **Add the .gitignore stanza** so the ticket file and P1 specs are tracked,
   everything else under `.adlc/` is not:
   ```
   .adlc/*
   !.adlc/tickets.json
   !.adlc/specs/
   ```
   If `.gitignore` already has the older two-line form (no `!.adlc/specs/`),
   add just the missing `!.adlc/specs/` line — don't touch anything else. The
   `specs/` directory holds the P1 spec for every ticket, arguably the most
   important contract in the lifecycle, so it must be tracked by default.
4. **Exclude `.adlc/` from this repo's formatters/linters.** `.adlc/tickets.json`
   is machine-written and, once a ticket declares `rails`, becomes a frozen
   trust root — reformatting it on a ticket branch trips `rails-guard`. Check
   for these configs and, only for the ones already present, add a `.adlc/`
   exclusion:
   - **Biome** (`biome.json`): merge an override —
     `{ "overrides": [{ "include": [".adlc/**"], "formatter": { "enabled": false }, "linter": { "enabled": false } }] }`.
   - **Prettier** (`.prettierignore`): append a `.adlc/` line.
   - **ESLint**: add `.adlc/**` to `ignorePatterns` in a JSON `.eslintrc*`, or
     append `.adlc/` to `.eslintignore`. For a flat `eslint.config.js`/`.mjs`/`.cjs`,
     don't auto-edit — tell the user to add `{ ignores: ['.adlc/**'] }` themselves.

   Never create a new formatter/linter config just to add this exclusion. If
   none of these are present, or the repo uses a different tool, document the
   manual fallback and move on.
5. **Wire the CI gate** (the real guarantee): copy `docs/ci/rails-guard.yml` into your
   pipeline and make it a required check. The in-session hook is advisory — `agy`
   fails **open** on a non-zero hook exit, so it cannot substitute for CI. The
   workflow template runs `scripts/rails-guard-ci.mjs` directly; treat that script
   as a required check in branch protection, not just an informational job.
6. **Activate enforcement** for a build: `export ADLC_P4_ENFORCEMENT=1` with an active
   ticket whose `rails[]` are frozen.
