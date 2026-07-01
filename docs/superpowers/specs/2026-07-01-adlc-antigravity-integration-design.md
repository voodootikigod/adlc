# ADLC × Google Antigravity (`agy`) — Native Integration Design

**Status:** approved design (pre-implementation)
**Date:** 2026-07-01
**Branch:** `feat/adlc-antigravity`
**Author:** Chris Williams

## 1. Purpose

Add a sixth native ADLC host integration — Google Antigravity (`agy` CLI) — alongside
Claude Code, Codex, Cursor, OpenCode, and Pi. Each existing integration does the same job
through its host's extension surface:

1. a **phase-router skill** teaching the agent the ADLC gates (`adlc <tool>` CLI);
2. an **`/adlc-init`** command that bootstraps `.adlc/`;
3. a **rails-guard hook** that DENIES edits to *frozen rails* (paths in the active ticket's
   `rails[]`), delegating the decision to `@adlc/core` (`loadTickets`, `globMatch`);
4. the **unbypassable backstop** — the commit-time CI diff gate
   (`scripts/rails-guard-ci.mjs`). The in-session hook is advisory; CI is authoritative.

The shared rail contract (identical across hosts): active ticket resolved from `ADLC_TICKET`
env **or** `.adlc/current-ticket.json` (conflict → fail closed); enforcement gated on
`ADLC_P4_ENFORCEMENT=1`; rails in force = active ticket's `rails[]` **plus** the trust-root
rails `.adlc/tickets.json` + `.adlc/current-ticket.json`; no-op when the repo isn't
ADLC-initialized, enforcement is off, or there's no active ticket; symlink aliases resolved
and denied.

This design is scoped to **peer-plugin parity** (rails + skills, like Cursor), reusing the
sibling `antigravity-booster` project's proven skills but **not** coupling to its `agb`
orchestrator.

## 2. Verified platform facts (probed live, agy 1.0.13, Linux)

Every fact below was confirmed by direct probing, not documentation. They are the design's
foundation and belong in the integration doc's appendix.

| # | Fact |
|---|------|
| V1 | agy has a **native plugin system**: `agy plugin install <path>` installs into `~/.gemini/config/plugins/<name>/`. Manifest is Claude-Code-shaped: root `plugin.json` (name, version) + `skills/`, `agents/`, `commands/` (auto-converted to skills), root `hooks.json`. `agy plugin import claude` even ingests Claude Code plugins. |
| V2 | `agy plugin validate` checks component **presence only**, not deep hook schema — it passed a `hooks.json` the runtime later refused to parse. **Validation is not sufficient; runtime load must be tested.** |
| V3 | **hooks.json schema (agy-native, ≠ Claude Code)** — verified working: `{ "<hook-name>": { "PreToolUse": [ { "matcher": ".*", "hooks": [ { "type":"command", "command":"<cmd>", "timeout":15 } ] } ] } }`. Top level is keyed by **hook name**, then event, then an **array** of `{matcher, hooks:[handler]}`. |
| V4 | `matcher` is a **regex on the tool name**. `.*` matches all. `write` did **not** match tool `write_to_file` — so use `.*` or exact names. |
| V5 | **Deny contract (INVERTED from Claude Code/Codex):** a hook denies by writing stdout `{"allow_tool": false, "deny_reason": "..."}` and **exiting 0**. `{"allow_tool": true}` allows. **Non-zero exit = hook FAILURE = FAIL-OPEN (tool proceeds).** |
| V6 | Hooks **fire in `agy --print` (headless) mode** — a write to a rail was actually blocked. So rails-guard protects both interactive sessions and the headless fleet path. |
| V7 | **stdin payload** (verbatim): `{"toolCall":{"name":"write_to_file","args":{"TargetFile":"/abs","CodeContent":"…","Overwrite":true}},"workspacePaths":[],"conversationId":…,"transcriptPath":…,"stepIdx":3}`. The path field varies per tool: `write_to_file`→`TargetFile`, `view_file`→`AbsolutePath`, `run_command`→`CommandLine`. Observed target paths were **absolute**. |
| V8 | Hook **cwd is the plugin dir** (`~/.gemini/config/plugins/<name>/`), **not the repo**. In `--print` mode `workspacePaths` was observed **empty (`[]`)**. There is **no workspace-root env var** (env exposes `ANTIGRAVITY_CONVERSATION_ID`, not a workspace path). |
| V9 | agy **expands `$HOME`** (and shell env vars) in the `command` string; there is **no** `${CLAUDE_PLUGIN_ROOT}`/`${AGY_PLUGIN_ROOT}`. Because plugins always install to `$HOME/.gemini/config/plugins/<name>/`, `node $HOME/.gemini/config/plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs` is portable across users with no install-time rewrite. |

## 3. Architecture

Three layers, mirroring the other five integrations:

1. **In-session rails-guard** (advisory): a native agy `PreToolUse` plugin hook.
2. **Phase-router + doctrine skills**: teach the agent the ADLC gates and operating discipline.
3. **Unbypassable CI backstop**: the existing host-independent `scripts/rails-guard-ci.mjs`
   diff gate — the real enforcement.

## 4. Package layout — `plugins/adlc-antigravity/`

```
plugin.json                 # agy manifest at ROOT: { "name": "adlc-antigravity", "version": … }
hooks.json                  # { "adlc-rails": { "PreToolUse": [ { "matcher": ".*", "hooks": [ …$HOME cmd… ] } ] } }
rails-checker.mjs           # COPIED VERBATIM from adlc-cursor (editor-agnostic; → @adlc/core)
constants.mjs               # PRETOOL_MATCHER = ".*"
hooks/
  adlc-rails-guard.mjs      # agy wire adapter — the only substantial new code (§5)
skills/
  adlc/SKILL.md             # phase-router (P0–P7 → adlc <tool>), stamped with the V1–V9 facts
  adlc-doctrine/SKILL.md    # vendored from antigravity-booster
  adlc-prosecutor/SKILL.md  # vendored from antigravity-booster
  adlc-self-orchestrate/SKILL.md  # vendored; documents handoff to `agb` (no code coupling)
agents/
  prosecutor.md             # P5 prosecutor subagent
commands/
  adlc-init.md              # bootstrap: runs `agy plugin install`, then `.adlc/` scaffolding
test/
  rails-guard.test.mjs      # unit tests over the adapter + checker
```

Plus, outside the package:
- `.agents/plugins/marketplace.json` — add an `adlc-antigravity` entry (agy shares the
  Codex-style `.agents` marketplace) so `agy plugin install adlc-antigravity@adlc` works.
- `docs/integrations/antigravity.md` — per-host doc (cursor.md structure: two-layer
  enforcement + P0–P7 coverage table + a **Verified hook-contract appendix** carrying V1–V9).
- `scripts/antigravity-install-smoke.mjs` — install/validate smoke test.
- Root `package.json` `test` script — append the plugin's `test/` and the smoke script.

## 5. The agy wire adapter — `hooks/adlc-rails-guard.mjs`

The one piece of substantial new code. `rails-checker.mjs` is reused verbatim because it is
editor-agnostic: `checkRail({filePath, tool, root, env}) → {decision:'allow'|'deny', reason}`,
plus `railPreconditions`, `classifyTool`, symlink-aware `resolveRailPath`,
`resolveActiveTicketId` (conflict → fail closed), and `TRUST_ROOT_RAILS`. agy's tool names
classify correctly through it because `normalizeToolName()` strips non-alpha:
`write_to_file`→`writetofile` (contains "write" → mutating), `view_file`→`viewfile`
(∈ `PURE_READS`), `run_command`→`runcommand` (∈ `SHELL_TOOL_NAMES` → not gated in-session).

### Adapter responsibilities

1. **Parse stdin** JSON; read `toolCall.name` and extract a path from `toolCall.args`
   defensively across keys: `TargetFile`, `AbsolutePath`, `CommandLine`, `path`,
   `file_path`, `FilePath`.
2. **Root derivation (agy-specific, §6 F2):** cwd is the plugin dir and `workspacePaths` may
   be `[]`. Derive the repo root by walking **up from the absolute target path** to the
   nearest ancestor containing `.adlc/`; use `workspacePaths[0]` when present. If the target
   path is **relative** or a root cannot be resolved, treat as **fail-closed** under
   enforcement (see §6 F2).
3. **Decide** via `checkRail({filePath, tool, root, env})`.
4. **Emit** `{"allow_tool": false, "deny_reason": "<reason>"}` on deny, else
   `{"allow_tool": true}`. **Always `exit 0`** (V5).
5. **Shell exemption:** `run_command` is a Turing-complete shell tool, **not** rail-gated
   in-session — its writes fall to the CI diff gate, same as Cursor/Claude Code.

## 6. Security hardening (from cross-model adversarial review)

The design was prosecuted by `agy` routed to **Gemini 3.1 Pro** (cross-model vs. the Claude
builder) via the `adversarial-review` skill. Verdict: **needs-attention**. Resolutions:

### F1 (critical) — startup/async exceptions must not fail open
An ESM `import` of `@adlc/core` throws at **module load**, before any `try/catch`; a non-zero
exit then **fails open** (V5). **Resolution:**
- The hook entry file registers `process.on('uncaughtException', …)` and
  `process.on('unhandledRejection', …)` **first**, before any risky work.
- No risky **top-level** imports: the entry does handler-registration, then **dynamic
  `import()`** of the checker inside `try/catch`.
- Every handler / catch path emits a decision and calls `process.exit(0)`. Under
  `ADLC_P4_ENFORCEMENT=1`, error paths emit `{"allow_tool": false, …}` — **fail closed**;
  when enforcement is off, emit allow (no-op). The process must never terminate non-zero.

### F2 (critical) — relative / unanchorable path must fail closed
With no workspace-root signal (V8) and possibly a relative `TargetFile`, naive root
derivation could return "inactive → allow" while agy writes the rail against the real repo.
**Resolution:** derive root from the **absolute** target path (walk up to `.adlc/`);
accept `workspacePaths[0]` when present. If the path is **relative** or **no `.adlc/` root
resolves**, then under `ADLC_P4_ENFORCEMENT=1` **fail closed** (`allow_tool:false`) rather
than allow. (Observed writes used absolute paths (V7), so the common path is unaffected.)

### F3 (high) — portable command path
Resolved by V9: the `command` uses `$HOME` (`node $HOME/.gemini/config/plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs`).
No install-time rewrite. A smoke test asserts the installed dir name equals the manifest `name`.

### F4 (high) — tool-classifier underscore names → REFUTED, with a follow-up
Refuted: `normalizeToolName()` strips underscores, so `view_file`/`run_command` already
classify correctly. **Follow-up task retained:** audit agy's full tool-name list (e.g.
`codebase_search`, `list_dir`, `grep_search`, any edit/replace tools) against `PURE_READS`
and `SHELL_TOOL_NAMES`, extending them where an agy-specific tool would otherwise fall to
`'other'` (fail-closed) and wrongly block a read.

## 7. Scope boundaries (YAGNI)

- **No** in-session shell-command rail parsing — deferred to the CI gate (parity with
  Cursor/Claude Code).
- **No** `agb` code coupling — `adlc-self-orchestrate` documents the handoff only.
- **No** scope / suppression-marker enforcement — that's Pi's richer-API tier; agy parity is
  rails + skills, like Cursor.

## 8. Testing & verification

- **Unit** (`test/rails-guard.test.mjs`): stdin-payload parsing across per-tool arg keys;
  root derivation (absolute target → `.adlc/`; relative/unanchorable → fail closed under
  enforcement); deny/allow emission shape (`allow_tool`/`deny_reason`); **exit code is always
  0**; enforcement-off no-op; conflict/corrupt-ticket fail-closed (inherited from checker);
  the F1 handlers (simulate a thrown error → asserts `allow_tool:false` + exit 0 under
  enforcement).
- **Smoke** (`scripts/antigravity-install-smoke.mjs`): `agy plugin validate` passes **and**
  the manifest/dir-name invariant holds; a fixture stdin denies a rail write and allows a
  non-rail write.
- Wire both into the root `package.json` `test` script.
- The unbypassable guarantee remains the CI `rails-guard-ci.mjs` diff gate, unchanged.

## 9. Open follow-ups (tracked, not blocking this design)

1. Audit agy's complete tool-name set against the classifier sets (F4 follow-up).
2. Confirm the hook-contract behavior on a future agy release (V2: validate ≠ runtime).
3. Optional later: interactive-mode `workspacePaths` population may allow a simpler root
   derivation; revisit if agy fills it.
