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

### Adapter decision tree (order is load-bearing; see §6 for the rationale)

1. **Parse stdin** JSON; read `toolCall.name`. Wrap everything from here in the fail-safe
   shell of §6 F1.
2. **Classify the tool FIRST (before any path/root work).** This gate exists so the `.*`
   matcher — which fires the hook on *every* tool — cannot turn root-resolution failure into
   a block of unrelated tools (§6 G1):
   - **read-only** tool (`classifyTool → 'readonly'`, e.g. `view_file`, `grep_search`) → **allow**.
   - **shell** tool (`run_command`) → **allow** in-session (Turing-complete; deferred to the
     CI diff gate, parity with Cursor/Claude Code).
   - **no file path** present in `toolCall.args` (e.g. `search_web`, `ask_question`,
     `list_permissions`) → **allow** (it is not a file mutation, so it can never touch a rail).
   - otherwise (a **mutating file tool**, or `'other'` carrying a path) → continue.
   The tools that reach step 3 are exactly the **mutating** file tools and the ambiguous
   `'other'` bucket (an unrecognized tool that *might* mutate).
3. **Extract the path** from `toolCall.args` defensively across keys: `TargetFile`,
   `AbsolutePath`, `path`, `file_path`, `FilePath`.
4. **Resolve-or-fail-closed (agy-specific; §6 F2/G2/H1/H2/H3).** The guiding principle: a tool
   that *might mutate a file* but that the hook **cannot fully resolve** must **fail closed**
   under enforcement — only a path that resolves to a *genuinely non-ADLC location* is a
   no-op allow. cwd is the plugin dir and `workspacePaths` may be `[]` (V8), so:
   - **No path extracted** (unknown arg key on a tool that classified `mutating`/`'other'`)
     → under `ADLC_P4_ENFORCEMENT=1` **deny** (H2); else allow. (A `'other'` tool with **no
     path and no mutating-hint** — e.g. `search_web` — was already allowed at step 2, so this
     branch only bites a name-mutating or path-shaped tool we failed to parse.)
   - **Relative path**: anchor via `workspacePaths[0]` if present → treat as absolute below.
     If **unanchorable** (relative *and* `workspacePaths` empty) → under enforcement **deny**
     (H1/H3); else allow. This is the headless-mode hole the G2 fix must not reopen.
   - **Absolute path**: walk **up** to the nearest ancestor containing `.adlc/tickets.json`.
     - **found** → `checkRail({filePath, tool, root, env})` (enforcement/ticket/conflict/
       corruption handling lives inside the checker).
     - **not found** → the path resolved to a **genuinely non-ADLC** location → **no-op
       allow** (preserves the "no-op when not initialized" contract; keeps non-ADLC projects
       usable under a global `ADLC_P4_ENFORCEMENT=1` — G2). Safe *because the path was
       absolute*, so we searched the real location, not the plugin dir.
5. **Emit** `{"allow_tool": false, "deny_reason": "<reason>"}` on deny, else
   `{"allow_tool": true}`. **Always `exit 0`** (V5).

## 6. Security hardening (from two cross-model adversarial-review passes)

The design was prosecuted **twice** by `agy` routed to **Gemini 3.1 Pro** (cross-model vs.
the Claude builder) via the `adversarial-review` skill — once on the raw design (F1–F4) and
once on the written spec (G1–G7). Both returned **needs-attention**; both sets are resolved
below.

### 6.0 Enforcement philosophy (the honest framing pass 2 forced)

agy's **fail-open-on-nonzero-exit** contract (V5) means the in-session hook **cannot be made
unconditionally fail-closed**: a startup syntax error, an incompatible Node runtime, a hook
**timeout**, or a Windows path failure all exit non-zero and **fail open**. Therefore, as in
all five existing integrations, **the in-session hook is advisory / best-effort, and the
commit-time CI diff gate (`scripts/rails-guard-ci.mjs`) is the real, unbypassable
guarantee.** The hardening below **shrinks the fail-open window** on the paths we control; it
does not — and cannot — eliminate it. The integration doc must state this plainly so the hook
is never mistaken for the guarantee.

### F1 / G4 (critical) — minimize the fail-open window on process startup & errors
An ESM `import` of `@adlc/core`, a syntax error, or a Node-version incompatibility throws at
**module load — before any `try/catch` or handler runs** — and a non-zero exit then fails
open (V5). **Resolution (best-effort, not absolute):**
- The hook entry is a **minimal, dependency-free `.cjs` shim** (smallest possible syntax
  surface) that (a) registers `process.on('uncaughtException')` + `unhandledRejection`
  **first**, then (b) **dynamic-`import()`s** the ESM checker inside `try/catch`. No risky
  top-level imports.
- Every handler / catch path emits a decision and `process.exit(0)`; under
  `ADLC_P4_ENFORCEMENT=1` error paths emit `{"allow_tool": false, …}` (fail closed), else
  allow. The process never *intentionally* exits non-zero.
- A CI test loads the shim on the **minimum supported Node version** and asserts a thrown
  checker error still yields `allow_tool:false` + exit 0 under enforcement.
- **Residual (documented, covered by CI gate):** a shim syntax error, a Node too old to run
  it, or a hook timeout (G7) still fails open in-session. Keep the hook fast (§F8) and rely
  on the CI gate.

### F2 / G1 / G2 (critical) — correct the fail-closed logic so it doesn't over-block
The pass-1 F2 wording ("no root resolves → fail closed") **regressed** two everyday cases.
Corrected per the §5 decision tree:
- **G1 — non-file / read-only tools** (`search_web`, `ask_question`, `view_file`, …) are
  **classified and allowed before** any root work, so root-resolution failure can never block
  them.
- **G2 — non-ADLC repositories**: "no `.adlc/` found up-tree" means **not initialized → no-op
  allow**, *not* fail-closed — so a global `ADLC_P4_ENFORCEMENT=1` doesn't lock down normal
  projects.
- **Fail-closed is narrow but complete** (pass-3 correction, H1/H2/H3): the no-op-allow
  fallback applies **only to an absolute path that resolves to a non-ADLC location**. A
  mutating/`'other'` tool that the hook cannot fully resolve fails closed under enforcement:
  - **H1/H3** — a **relative** path with empty `workspacePaths` (headless mode) is
    unanchorable → **deny** (previously it fell through to the non-ADLC no-op-allow and
    bypassed the rail). §5 and §6 now agree: relative+unanchorable ⇒ deny, never allow.
  - **H2** — a tool that classifies **mutating by name** but exposes its path under an
    **unrecognized arg key** (path extraction returns nothing) → **deny**. (`'other'` tools
    with neither a path nor a mutating-hint — `search_web` — remain allowed at step 2, so G1
    is preserved.)
  - Only an **absolute** path (V7 — the observed common case) that walks up and finds **no**
    `.adlc/` is a genuine non-ADLC no-op allow (G2).

### F3 / G6 (high) — portable command path, POSIX-scoped
V9: the `command` uses `$HOME`
(`node $HOME/.gemini/config/plugins/adlc-antigravity/hooks/adlc-rails-guard.mjs`) — portable
across **POSIX** users with no install rewrite; a smoke test asserts the installed dir name
equals the manifest `name`. **G6:** `$HOME`/forward-slashes are **not** reliable on Windows
shells, where a failed command fails open (V5). **v1 scopes the in-session hook to
macOS/Linux** (matching antigravity-booster, whose sandbox is macOS-only and Linux is
preview); the doc states Windows in-session is unsupported, and **the cross-platform CI gate
protects Windows users** regardless.

### F4 / G3 (high→blocking) — tool-classifier audit is a build task, not a follow-up
Refuted as stated (`normalizeToolName()` strips underscores, and `MUTATING_TOOL_HINTS`
includes `replace`/`edit`/`patch`/`create`, so `replace_file_content`→`replacefilecontent` is
already caught as mutating). **But** correctness depends on it, so the audit is **promoted to
a blocking implementation task**: enumerate agy's real tool names (`agy` probing) and assert,
in tests, that **every** mutating file tool classifies `mutating` (denies a rail) and **every**
read/non-file tool is allowed — extending `PURE_READS` / `SHELL_TOOL_NAMES` /
`MUTATING_TOOL_HINTS` for any agy-specific tool that would otherwise fall to `'other'`.

### F8 / G7 (medium) — keep the hook fast to shrink the timeout fail-open
The hook does only small file reads + glob matching; target **< a few hundred ms**. Set a
comfortable `timeout` in `hooks.json`. A timeout still fails open (V5) — documented residual,
covered by the CI gate.

## 7. Scope boundaries (YAGNI)

- **No** in-session shell-command rail parsing — deferred to the CI gate (parity with
  Cursor/Claude Code).
- **No** `agb` code coupling — `adlc-self-orchestrate` documents the handoff only.
- **No** scope / suppression-marker enforcement — that's Pi's richer-API tier; agy parity is
  rails + skills, like Cursor.

## 8. Testing & verification

- **Unit** (`test/rails-guard.test.mjs`) — must include an explicit case per finding:
  - stdin-payload parsing across per-tool arg keys (`TargetFile`/`AbsolutePath`/…);
  - deny/allow emission shape (`allow_tool`/`deny_reason`) and **exit code is always 0** (V5);
  - **G1** — a non-file tool (`search_web`) and a read-only tool (`view_file`) are **allowed
    under `ADLC_P4_ENFORCEMENT=1`** (not blocked by root failure);
  - **G2** — a `write_to_file` with an **absolute** path in a repo with **no `.adlc/`** is
    **allowed** under global enforcement (no-op, not fail-closed);
  - **H1/H3** — a mutating write with a **relative** path and empty `workspacePaths`
    (headless) is **denied** under enforcement (must NOT fall through to G2 no-op-allow);
  - **H2** — a name-mutating tool whose path is under an **unrecognized arg key** (no path
    extracted) is **denied** under enforcement;
  - rail hit — a mutating write to a frozen rail inside an ADLC repo is **denied**;
  - **G3** — a table of agy's real mutating tool names each **denies** a rail write, and each
    real read/non-file tool is **allowed**;
  - narrow fail-closed — mutating tool + `.adlc/` present + unanchorable path + enforcement →
    **deny**;
  - enforcement-off no-op; conflict / corrupt-ticket fail-closed (inherited from checker);
  - **F1/G4** — the `.cjs` shim, on a simulated checker throw, still emits `allow_tool:false`
    + exit 0 under enforcement; a CI step loads the shim on the **min supported Node version**.
- **Smoke** (`scripts/antigravity-install-smoke.mjs`): `agy plugin validate` passes, the
  installed **dir-name == manifest `name`** invariant holds (F3), and a fixture stdin denies a
  rail write and allows a non-rail write.
- Wire both into the root `package.json` `test` script.
- **The unbypassable guarantee remains the CI `rails-guard-ci.mjs` diff gate** — the
  in-session hook is advisory (§6.0).

## 9. Open follow-ups (tracked, not blocking this design)

1. Confirm the hook-contract behavior on a future agy release (V2: validate ≠ runtime).
2. Windows in-session support (G6) — revisit if agy exposes a cross-platform plugin-root
   placeholder or reliable env expansion.
3. Optional later: interactive-mode `workspacePaths` population may allow a simpler root
   derivation; revisit if agy fills it.
4. Petition the agy team to **fail closed on hook non-zero exit / timeout** (V5) — the single
   change that would let the in-session hook become a real guarantee rather than advisory.

(The agy tool-name classifier audit, formerly a follow-up, is now the **blocking build task
F4/G3** in §6.)
