# Spec — Claude Code plugin guidance must recommend the namespaced command form (closes #50)

## Issue

The Claude Code native integration (`plugins/adlc-claude-code/`) is installed as a
plugin named `adlc` (`plugins/adlc-claude-code/.claude-plugin/plugin.json`), so the
real, invocable form of a plugin command inside Claude Code is the namespaced
`/adlc:adlc-<name>` (e.g. `/adlc:adlc-ticket`), not the bare `/adlc-<name>`. Every
command's own heading, the discovery skill's phase router, and cross-references
between commands recommended the bare form — a suggestion that silently fails to
invoke when followed, on every communication (issue #50).

## Acceptance criteria

- No `.md`/`.mjs` file under `plugins/adlc-claude-code/{commands,skills,agents,hooks}`
  recommends a bare `/adlc-init`, `/adlc-ticket`, `/adlc-distill`, or `/adlc-maintain`
  — all such references use the scoped `/adlc:adlc-<name>` form.
- `docs/integrations/claude-code.md` — the plugin's own homepage doc (`plugin.json`'s
  `homepage` field points at it) — is in scope too: its Install quick-start blocks,
  Commands reference table, and Lifecycle coverage table all use the scoped
  `/adlc:adlc-<name>` form. This is the first doc a user reads after installing, so a
  bare recommendation there is the exact regression #50 was filed against.
- The five other harness integrations (`adlc-antigravity`, `adlc-cursor`,
  `adlc-opencode`, `adlc-codex`, `adlc-pi`) are left unscoped where their harness has
  no plugin-namespace command convention (verified per-harness against each
  integration's own doc: Antigravity commands are auto-converted to bare-invoked
  skills; Cursor and OpenCode document bare `/adlc-*`; Codex/Pi are skill-, not
  slash-command-, driven). Only Claude Code needed the fix.
- The generated phase router (`plugins/adlc-claude-code/skills/adlc/SKILL.md`) is
  produced by the single canonical source `scripts/router/router-model.mjs` (T13/T14);
  the fix lives in that source (new `CMD_INIT`/`CMD_TICKET`/`CMD_DISTILL`/
  `CMD_MAINTAIN` per-harness slots — scoped for `claude-code`, unscoped for
  `antigravity`) and is regenerated with `node scripts/router/gen-routers.mjs`, so the
  fix cannot drift from the committed file.
- `scripts/claude-code-plugin-smoke.mjs` gained a regression guard: it fails (exit 2)
  if any bare, non-namespaced `/adlc-init|adlc-ticket|adlc-distill|adlc-maintain`
  reference is found in a commands/skills/agents/hooks `.md`/`.mjs` file (excluding
  file-path mentions like `commands/adlc-init.md`), or in
  `docs/integrations/claude-code.md`.

## Verify

```sh
node scripts/claude-code-plugin-smoke.mjs .
node --test scripts/test/claude-code-plugin-smoke.test.mjs
node scripts/router/gen-routers.mjs --check
node --test scripts/test/*.test.mjs
npm test
```
