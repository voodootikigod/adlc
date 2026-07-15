# Spec — Cursor marketplace plugin distribution (T47)

**Phase:** P1 contract for shipping ADLC as a native Cursor plugin.

## Problem

`@adlc/cursor` achieved native parity (T16–T19) as an **npm scaffolder** that
copies hooks, rules, and commands into each consumer's `.cursor/`. That matched
Cursor when it had no plugin marketplace. Cursor now documents a first-class
plugin model (`.cursor-plugin/plugin.json`, repo `marketplace.json`,
[cursor.com/marketplace](https://cursor.com/marketplace/publish)) plus skills,
agents, and a verified hook event set that includes `stop` and
`beforeSubmitPrompt`.

ADR-0006 still asserts Cursor has no marketplace. Install remains two npm steps
(`npm i -g @adlc/cli` + `npx @adlc/cursor .`). Hook wiring still uses absolute
`PLUGIN_ROOT` paths and leaves documented events behind `--wire-unpinned`.

## Goal

Primary install path:

1. Install the ADLC Cursor plugin from the repo marketplace (local/git).
2. `npm install -g @adlc/cli`
3. `adlc init` (writes `.adlc/` runtime + hygiene only)
4. Wire CI `docs/ci/rails-guard.yml` as the unbypassable rail backstop

Keep `npx @adlc/cursor .` as a **legacy/dev fallback** that scaffolds project
`.cursor/` files with relative `node_modules/@adlc/cursor` hook paths.

## Deliverables

### D1 — Plugin manifest

`plugins/adlc-cursor/.cursor-plugin/plugin.json` with:

- `name`: `adlc-cursor` (kebab-case)
- `version`: lockstep with `plugins/adlc-cursor/package.json`
- `description`, `author`, `homepage` → `docs/integrations/cursor.md`
- `repository`, `license`, `keywords`
- Explicit component paths when non-default: `"commands": "./command/"`,
  `"hooks": "./hooks/hooks.json"`, `"rules": "./rules/"`, `"skills": "./skills/"`

### D2 — Repo marketplace

Root `.cursor-plugin/marketplace.json` listing `adlc-cursor` with
`"source": "./plugins/adlc-cursor"`, mirroring `.claude-plugin/marketplace.json`
and `.agents/plugins/marketplace.json`.

### D3 — Relative hooks + documented events on by default

- Ship `plugins/adlc-cursor/hooks/hooks.json` (Cursor plugin discovery path) **and**
  keep root `hooks.json` in sync (or generate one from the other — no drift).
- Hook `command` values are relative: `node ./hooks/adlc-pretool.mjs` (plugin cwd).
- Wire by default: `preToolUse`, `afterFileEdit`, `beforeShellExecution`,
  `stop`, `beforeSubmitPrompt`.
- Scaffold `mergeHooks` defaults to wiring stop/preflight (`wireUnpinned: true`);
  opt-out via `--no-unpinned` / `ADLC_CURSOR_WIRE_UNPINNED=0`.
- Scaffolded **project** hooks prefer
  `node "./node_modules/@adlc/cursor/hooks/<script>.mjs"` (no absolute paths).

### D4 — Skills (agents deferred)

Ship plugin skills (folder discovery under `skills/`):

| Skill | Role |
| --- | --- |
| `adlc` | Phase router (Cursor-flavored; reference `/adlc-*` commands) |
| `adlc-init` | Bootstrap via `adlc init` + optional legacy scaffold |

Prosecutor agent fan-out stays **out of scope** for T47. Keep sequential
`/adlc-prosecute` and the independence caveat.

### D5 — `adlc init` for Cursor runtime

Extend `packages/init` / CLI help so Cursor users run `adlc init` (or
`adlc init --no-codex-agents`) for `.adlc/` only. Do not require
`npx @adlc/cursor` for runtime state. Codex agent templates remain the default
when not disabled. Add a `--harness cursor` alias that implies `--no-codex-agents`
and records `harnesses.cursor` in config when creating fresh config.

### D6 — Truth sweep

Update:

- `docs/integrations/cursor.md`
- `apps/docs/content/docs/integrations/cursor.mdx`
- `apps/docs/lib/integration-facts.mjs`
- `docs/adr/0006-adlc-cursor-integration.md` (marketplace premise + hook pins)
- `plugins/adlc-cursor/README.md`

Remove claims that Cursor has no plugin marketplace. Document marketplace
install, update/remove guidance at the fidelity Cursor docs allow, and the
human-only `cursor.com/marketplace/publish` checklist. Keep CI rails-guard as
the control; in-session deny remains best-effort.

### D7 — Smoke + packaging

Extend `scripts/cursor-install-smoke.mjs` and packaging tests for AC1–AC6 below.

## Acceptance criteria

- **AC1 — manifest:** `.cursor-plugin/plugin.json` has required `name`; `version`
  equals `package.json` version.
  Verify: `node --test plugins/adlc-cursor/test/packaging.test.mjs`.
- **AC2 — marketplace:** root `.cursor-plugin/marketplace.json` lists
  `adlc-cursor` → `./plugins/adlc-cursor`.
  Verify: `node scripts/cursor-install-smoke.mjs .`.
- **AC3 — hooks:** default hook configs use non-absolute command paths; `stop`
  and `beforeSubmitPrompt` present by default.
  Verify: `node --test plugins/adlc-cursor/test/scaffold.test.mjs` and
  `node scripts/cursor-install-smoke.mjs .`.
- **AC4 — skills:** `skills/adlc/SKILL.md` and `skills/adlc-init/SKILL.md` exist
  with `name` + `description` frontmatter; `files` allowlist packs `skills/`.
  Verify: `node scripts/cursor-install-smoke.mjs .` and
  `node --test plugins/adlc-cursor/test/packaging.test.mjs`.
- **AC5 — init:** `adlc init --root <tmp> --harness cursor --json` (or
  `--no-codex-agents`) creates `.adlc/config.json` without writing Codex agents.
  Verify: `node --test packages/init/test/scaffold.test.mjs`.
- **AC6 — docs:** integration-facts Cursor install is marketplace-first; ADR-0006
  and cursor docs do not claim "no plugin marketplace".
  Verify: `node --test apps/docs/test/integration-facts.test.mjs` and
  `node scripts/cursor-install-smoke.mjs .`.
- **AC7 — regression:** Verify:
  `node scripts/cursor-install-smoke.mjs .`,
  `node --test plugins/adlc-cursor/test/*.test.mjs`, and
  `node --test packages/init/test/*.test.mjs`.

## Out of scope

- Live deny-proof against a real Cursor binary (GA honesty gate; document only).
- Human submit on cursor.com/marketplace/publish (document checklist only).
- Full five-lens fresh-context prosecutor agents.
- Porting the Codex MCP server.
- Breaking removal of the `@adlc/cursor` npm package / scaffolder.

## Binding decisions

1. **Marketplace is primary; scaffolder is fallback.** Do not delete the npm bin
   in this ticket.
2. **Keep `command/` directory name** (existing deploy + tests); point the
   Cursor plugin manifest at it via `"commands": "./command/"`.
3. **No invented hook events** beyond Cursor's documented set. `stop` and
   `beforeSubmitPrompt` are now documented → default-on.
4. **CI rails-guard remains the unbypassable control.** In-session deny stays
   advisory (`failClosed: false`).
5. **Rule upgrade** (versioned refresh of `adlc.mdc`) is nice-to-have; not
   required for AC. Prefer marketplace delivery so consumers get rule updates
   with the plugin without project copies.
