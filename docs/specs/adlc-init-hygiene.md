# Spec — adlc-init hygiene sweep (#46, #42, #43)

**Phase:** P1 record for the `adlc-init-hygiene` cluster. Three related hygiene fixes to
the per-harness `/adlc-init` bootstrap and the `/adlc-ticket` authoring flow, surfaced by
running a full P0→P6 ADLC cycle on an external repo.

## Issue #46 — track `.adlc/specs/` by default

**Problem:** every `/adlc-init`'s documented `.gitignore` stanza was `.adlc/*` +
`!.adlc/tickets.json` only, so the P1 spec at `.adlc/specs/T<n>.md` — arguably the most
important contract in the lifecycle — was left untracked by default.

**Acceptance criteria:**
- Every harness's `/adlc-init` (`adlc-claude-code`, `adlc-opencode`, `adlc-antigravity`,
  `adlc-cursor`) documents a three-line stanza: `.adlc/*`, `!.adlc/tickets.json`,
  `!.adlc/specs/`.
- Where a deterministic scaffolder exists (`adlc-opencode`, `adlc-cursor`), `ensureGitignore()`
  in `lib/scaffold.mjs` writes/repairs this stanza: creates it fresh if `.gitignore` is
  absent, and adds only the missing `!.adlc/specs/` line if the older two-line form is
  already present, leaving every other line untouched.

**Verify:**
```sh
node --test plugins/adlc-opencode/test/scaffold.test.mjs
node --test plugins/adlc-cursor/test/scaffold.test.mjs
```

## Issue #42 — exclude `.adlc/` from repo formatters/linters

**Problem:** `.adlc/tickets.json` is machine-written (`JSON.stringify(…, null, 2)`). Once a
ticket declares `rails`, the file becomes a frozen trust root that cannot be reformatted on
a ticket branch without tripping `rails-guard` — so a repo formatter reformatting it turns
CI red on the very next PR.

**Acceptance criteria:**
- Every harness's `/adlc-init` documents detecting and updating, only for configs already
  present in the target repo: Biome (`biome.json` → merged `overrides` entry disabling
  formatter/linter for `.adlc/**`), Prettier (`.prettierignore` → appended `.adlc/` line),
  ESLint (`ignorePatterns` in a JSON `.eslintrc*`, or `.eslintignore`; flat
  `eslint.config.js`/`.mjs`/`.cjs` is detected but not auto-edited).
- The manual fallback is documented for tools not auto-detected (flat ESLint config, or any
  other formatter/linter).
- `lib/scaffold.mjs`'s `ensureFormatterIgnores()` (opencode, cursor) implements this
  deterministically and is wired into `scaffold()`.

**Verify:**
```sh
node --test plugins/adlc-opencode/test/scaffold.test.mjs
node --test plugins/adlc-cursor/test/scaffold.test.mjs
```

## Issue #43 — warn if the quality check flags `tickets.json` after a write

**Problem:** nothing in the `/adlc-ticket` authoring flow caught the formatter conflict
above; it was discovered only on the next PR, after `.adlc/tickets.json` had already been
committed.

**Acceptance criteria:**
- Both harnesses that ship `/adlc-ticket` (`adlc-claude-code`, `adlc-opencode`) document a
  step, run immediately after the atomic write and lock release, that: looks for
  `scripts.check` then `scripts.lint` in `package.json`; detects the package manager from
  the lockfile; runs that check scoped to `.adlc/tickets.json` where the underlying tool
  supports a path argument, else the full script; and on failure **warns** (never fails or
  reverts the write) with a pointer back to `/adlc-init`'s formatter-ignore step.
- No script found → skip silently; check passes → continue silently.

**Verify:** manual read-through of `plugins/adlc-claude-code/commands/adlc-ticket.md` §3 and
`plugins/adlc-opencode/command/adlc-ticket.md` §4 (this is an agentic instruction, not a
deterministic script — there is no unit test to run).

## Full regression check

```sh
node --test plugins/adlc-opencode/test/*.test.mjs
node --test plugins/adlc-cursor/test/*.test.mjs
node --test plugins/adlc-antigravity/test/*.test.mjs
node --test plugins/adlc-claude-code/hooks/test/*.test.mjs
node scripts/cursor-install-smoke.mjs .
node scripts/opencode-install-smoke.mjs .
node scripts/antigravity-install-smoke.mjs .
```
