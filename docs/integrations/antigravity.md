# ADLC × Google Antigravity (`agy`)

Native ADLC integration for the Antigravity CLI. Two layers:

1. **In-session rails-guard (advisory).** A `PreToolUse` plugin hook denies edits to
   frozen rails. It is best-effort: agy fails **open** on a non-zero hook exit, so a
   hook crash/timeout/Windows-path failure can let a rail write through.
2. **CI diff gate (the guarantee).** `scripts/rails-guard-ci.mjs` (documented in
   [`docs/ci/rails-guard.yml`](../ci/rails-guard.yml)) is the unbypassable,
   cross-platform control. Make it a required check.

## Install

```sh
agy plugin install adlc-antigravity@adlc     # via the .agents marketplace
# or, from a local checkout:
agy plugin install /abs/path/plugins/adlc-antigravity
```

Then `/adlc-init`. Enforcement: `export ADLC_P4_ENFORCEMENT=1` with an active ticket.

## Formal ADLC Coverage

| Phase | Antigravity surface |
|-------|---------------------|
| P0 Triage | `/adlc-init`, `adlc-ticket` skill → `.adlc/tickets.json` |
| P1 Interrogate | `adlc spec-lint/premortem/parallax` via the `adlc` CLI |
| P2 Decompose | `adlc coldstart/model-router/merge-forecast` |
| P3 Rail | **PreToolUse rails-guard hook** (advisory) + CI gate (guarantee) |
| P4 Build | doctrine skill; `adlc flail-detector/consensus-fix` |
| P5 Prosecute | `adlc-prosecutor` skill + `prosecutor` agent; `adlc hollow-test/behavior-diff` |
| P6 Integrate | human gate — `adlc gate-manifest` |
| P7 Distill | `adlc lesson-foundry/rejection-mining` |

## Rail enforcement — two layers

Antigravity's hooks are a **best-effort, in-session** layer, not the control:

1. **In-session (advisory).** The `PreToolUse` hook returns
   `{ "allow_tool": false, "deny_reason": "..." }` on a frozen-rail edit. Antigravity
   *should* block it, but the hook is subject to several fail-open conditions (see
   "Platform notes" below). The hook is configured to fail **open** so a hook
   bug/timeout/incompatibility can never brick your session. Bash/shell writes are
   **not** gated in-session (a Turing-complete shell can't be reliably parsed).

2. **Commit-time (unbypassable).** The real control is the CI rail-freeze gate
   (`scripts/rails-guard-ci.mjs`). It reads the frozen rail set **from the trusted base
   ref** and rejects any PR that edits a path frozen there, regardless of how the edit
   was made. **Make it a required check.**

   **Scope limit:** because the rail set is read from the base ref, the gate protects
   rails **already frozen on the base branch**. A PR that *introduces* a new rail
   **and** edits that path in the same PR is **not** caught — first-time rails are
   enforced only once they land on the base branch. Freeze rails in a separate,
   merged commit before the build PR if you need same-PR protection.

## Rail contract

Enforcement is identical to the sibling integrations (the engine is `@adlc/core`,
not re-implemented here):

- Active ticket via `ADLC_TICKET` **or** `.adlc/current-ticket.json`; a conflict
  between the two fails closed (denied).
- Enforcement is phase-scoped to `ADLC_P4_ENFORCEMENT=1`; otherwise no-op.
- Rails in force = the **single** active ticket's `rails` plus the trust-root rails
  `.adlc/tickets.json` and `.adlc/current-ticket.json` (not a union across tickets).
- No-op when the repo is not ADLC-initialized, enforcement is off, or no active
  ticket resolves.
- Symlink aliases whose real target is a frozen rail are resolved and denied.

## Platform notes / limitations

- **POSIX only in-session** (`$HOME` command path); Windows in-session is unsupported —
  the CI gate protects Windows users regardless.
- Shell (`run_command`) writes are not gated in-session (CI gate catches them).

## Appendix: verified `agy` hook contract (agy 1.0.13)

This appendix documents the native hook contract verified by direct probing. These
facts are the foundation for the in-session rails-guard implementation and belong in
any document describing the integration's enforcement surface.

| # | Fact |
|---|------|
| V1 | agy has a **native plugin system**: `agy plugin install <path>` installs into `~/.gemini/config/plugins/<name>/`. Manifest is Claude-Code-shaped: root `plugin.json` (name, version) + `skills/`, `agents/`, `commands/` (auto-converted to skills), root `hooks.json`. `agy plugin import claude` even ingests Claude Code plugins. |
| V2 | `agy plugin validate` checks component **presence only**, not deep hook schema — it passed a `hooks.json` the runtime later refused to parse. **Validation is not sufficient; runtime load must be tested.** |
| V3 | **hooks.json schema (agy-native)** — verified working: `{ "<hook-name>": { "PreToolUse": [ { "matcher": ".*", "hooks": [ { "type":"command", "command":"<cmd>", "timeout":15 } ] } ] } }`. Top level is keyed by **hook name**, then event, then an **array** of `{matcher, hooks:[handler]}`. |
| V4 | `matcher` is a **regex on the tool name**. `.*` matches all. `write` did **not** match tool `write_to_file` — so use `.*` or exact names. |
| V5 | **Deny contract (INVERTED from Claude Code/Codex):** a hook denies by writing stdout `{"allow_tool": false, "deny_reason": "..."}` and **exiting 0**. `{"allow_tool": true}` allows. **Non-zero exit = hook FAILURE = FAIL-OPEN (tool proceeds).** |
| V6 | Hooks **fire in `agy --print` (headless) mode** — a write to a rail was actually blocked. So rails-guard protects both interactive sessions and the headless fleet path. |
| V7 | **stdin payload** (verbatim): `{"toolCall":{"name":"write_to_file","args":{"TargetFile":"/abs","CodeContent":"…","Overwrite":true}},"workspacePaths":[],"conversationId":…,"transcriptPath":…,"stepIdx":3}`. The path field varies per tool: `write_to_file`→`TargetFile`, `view_file`→`AbsolutePath`, `run_command`→`CommandLine`. Observed target paths were **absolute**. |
| V8 | Hook **cwd is the plugin dir** (`~/.gemini/config/plugins/<name>/`), **not the repo**. In `--print` mode `workspacePaths` was observed **empty (`[]`)**. There is **no workspace-root env var** (env exposes `ANTIGRAVITY_CONVERSATION_ID`, not a workspace path). |
| V9 | agy **expands `$HOME`** (and shell env vars) in the `command` string; there is **no** `${CLAUDE_PLUGIN_ROOT}`/`${AGY_PLUGIN_ROOT}`. Because plugins always install to `$HOME/.gemini/config/plugins/<name>/`, `node $HOME/.gemini/config/plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs` is portable across users with no install-time rewrite. |
