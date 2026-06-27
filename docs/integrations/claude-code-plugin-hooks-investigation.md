# Claude Code Plugin Hooks — Live Investigation Notes

**Date:** 2026-06-22
**Context:** Live install testing of the `adlc` CC plugin during the `restructure/layout` migration.
**Outcome:** All four hooks working. Key findings documented here for future maintainers.

---

## Background

As part of restructuring the repo layout, the CC plugin integration moved from root-level directories into `plugins/adlc-claude-code/`. This required figuring out how CC actually installs plugins and executes hook commands — none of which was documented, so we learned it entirely through live experimentation.

---

## The Full Install Sequence

Two steps are required; the first alone is not enough:

```
/plugin marketplace add voodootikigod/adlc   # registers the plugin source
/plugin install adlc@adlc                    # actually installs the plugin files
```

CC installs plugin files to `~/.claude/plugins/cache/<name>/<version>/`.

---

## What We Discovered About `plugin.json`

### `additionalProperties: false`

CC's plugin.json schema is strict. We had added four extra fields beyond the standard metadata:

```json
"hooks": "./hooks/hooks.json",
"commands": "./commands/",
"agents": "./agents/",
"skills": "./skills/"
```

Install failed immediately with: `failed to install: invalid manifest file at .../.claude-plugin/plugin.json`

**Fix:** Remove all four fields. Only these eight are allowed:
`name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`

### `hooks/hooks.json` is auto-loaded by convention

When we added back just the `hooks` field to test it, we got:

> Hook load failed: Duplicate hooks file detected: `./hooks/hooks.json` resolves to already-loaded file `~/.claude/plugins/cache/adlc/0.1.0/hooks/hooks.json`. The standard hooks/hooks.json is loaded automatically, so manifest.hooks should only reference additional hook files.

**Key insight:** CC automatically loads `hooks/hooks.json` from the plugin source directory. You do not need to declare it in `plugin.json`. The `hooks` field is only for *additional* hook files beyond the standard location.

Commands, agents, and skills directories are also discovered by filesystem convention — no explicit fields required.

---

## What We Discovered About Hook Command Paths

This was the hardest part. We went through four wrong approaches before finding the correct one.

### Attempt 1 — Repo-root-relative path

```json
"command": "node ./plugins/adlc-claude-code/hooks/adlc-hook-run.mjs rails"
```

**Result:** Silent failure. No error, no hook output. The file does not exist inside the plugin install directory (`~/.claude/plugins/cache/adlc/0.1.0/`), so node exits with MODULE_NOT_FOUND. Advisory hooks swallow non-zero exits — invisible failure.

### Attempt 2 — Plugin-dir-relative path

```json
"command": "node ./hooks/adlc-hook-run.mjs rails"
```

**Result:** Silent failure. We assumed CC runs hooks with CWD = plugin install directory. Wrong — CC runs hooks with CWD = the user's current project directory. `./hooks/` doesn't exist in most projects.

### Attempt 3 — `${PLUGIN_ROOT}` (Codex convention)

```json
"command": "node \"${PLUGIN_ROOT}/hooks/adlc-hook-run.mjs\" rails"
```

**Result:** CJS loader error — `node:internal/modules/cjs/loader:1423`. This was actually useful: it confirmed the hook IS being executed, but `${PLUGIN_ROOT}` is a Codex env var, not a CC one. CC does not set it. Node received the literal string `${PLUGIN_ROOT}/hooks/adlc-hook-run.mjs` as a path.

**Side note:** The quoted form (`"node \"${...}\""`) may also interfere with CC's variable substitution — production plugins all use the unquoted form.

### Attempt 4 — `${CLAUDE_PLUGIN_ROOT}` (correct)

```json
"command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/adlc-hook-run.mjs rails"
```

**Result:** Works. This was confirmed by researching production CC plugins.

---

## The Research That Cracked It

After cycling through four wrong approaches, we fetched and examined two public CC plugin repos:

- **[Dev-GOM/claude-code-marketplace](https://github.com/Dev-GOM/claude-code-marketplace)** — 20+ plugins covering sound notifications, TODO tracking, git auto-backup, complexity monitoring, etc.
- **[ruvnet/ruflo](https://github.com/ruvnet/ruflo)** — resilient hook patterns with `|| true` guards.

Every single plugin across both repos uses `${CLAUDE_PLUGIN_ROOT}` unquoted:

```json
"command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/init-config.js"
"command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/sound-hook-executor.js -HookType SessionStart"
"command": "\"${CLAUDE_PLUGIN_ROOT}/scripts/ruflo-hook.sh\" modify-bash || true"
```

**CC injects `CLAUDE_PLUGIN_ROOT` as an environment variable** pointing at the plugin's install directory (e.g., `~/.claude/plugins/cache/adlc/0.1.0`). The variable substitution happens before node is spawned — so the unquoted form works even though CC does not use a POSIX shell.

---

## Diagnostic Technique That Works

When you need to confirm whether a hook is firing at all, use an inline `node -e` command with no file path dependency:

```json
"command": "node -e \"require('fs').appendFileSync('/tmp/adlc-hook-cc.log',JSON.stringify({PLUGIN_ROOT:process.env.PLUGIN_ROOT,CLAUDE_PLUGIN_ROOT:process.env.CLAUDE_PLUGIN_ROOT,cwd:process.cwd()})+String.fromCharCode(10))\""
```

This fires if and only if CC invokes the hook command. It also dumps the env vars CC provides, which is how you find out what's available for path resolution.

---

## Cache Clearing

Stale cache entries cause `EINVAL: invalid argument, rename` errors during reinstall. Always clear before reinstalling:

```sh
rm -rf ~/.claude/plugins/cache/adlc
```

This happens because a failed or partial install can leave a flat directory at `cache/adlc` that conflicts when CC tries to version it to `cache/adlc/0.1.0`.

---

## Final Working State

**`plugin.json`** — eight core metadata fields only, no extras:
```json
{ "name", "version", "description", "author", "homepage", "repository", "license", "keywords" }
```

**`hooks/hooks.json`** — auto-loaded by CC, commands use `${CLAUDE_PLUGIN_ROOT}` unquoted:
```json
"command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/adlc-hook-run.mjs rails"
```

**`adlc-hook-run.mjs`** — CWD-independent dispatcher. Locates `adlc-hook.mjs` via `import.meta.url` once node finds and loads it. The path in hooks.json gets it to node; after that, CWD doesn't matter.

---

## Hook Matcher Asymmetry (PreToolUse vs PostToolUse)

This is a load-bearing invariant worth noting explicitly because it is non-obvious and has a dedicated regression test.

- **PreToolUse** rails matcher: `Edit|Write|MultiEdit|NotebookEdit` — **Bash is deliberately excluded**.
- **PostToolUse** flail matcher: `Edit|Write|MultiEdit|NotebookEdit|Bash` — Bash is included.

Bash is excluded from PreToolUse because a shell is Turing-complete and cannot be reliably parsed for "which file will this mutate" — any in-session parser has a bypass (wrappers, subshells, globs, `eval`, etc.). Rail mutations via Bash are instead caught by the unbypassable CI diff gate at commit time (`adlc rails-guard`). The PostToolUse flail hook's Bash inclusion is unrelated to rail enforcement — it just needs to see all tool calls to detect looping.

**The rails test suite has a dedicated test asserting Bash is NOT in the PreToolUse matcher.** If Bash were accidentally added to that matcher, the hook would start routing all shell calls through the rail gate — which cannot parse them — and would either fail open (allow all Bash) or incorrectly block legitimate commands.

---

## Gotchas Summary

| Gotcha | What happens | Correct approach |
|---|---|---|
| Using `${PLUGIN_ROOT}` | Silent failure — Codex var, not set by CC | Use `${CLAUDE_PLUGIN_ROOT}` |
| Quoting `"${CLAUDE_PLUGIN_ROOT}"` | May break CC's substitution | Leave unquoted |
| Explicit `hooks` field in plugin.json | "Duplicate hooks file" install error | Omit — auto-loaded by convention |
| Extra fields in plugin.json | "Invalid manifest" install rejection | Only the 8 core metadata fields |
| Stale plugin cache | EINVAL rename error on reinstall | `rm -rf ~/.claude/plugins/cache/<name>` |
| Relative `./hooks/` path | Silent failure — CWD is user's project, not plugin dir | Use `${CLAUDE_PLUGIN_ROOT}` |
| Only doing `/plugin marketplace add` | Plugin source registered but not installed | Also run `/plugin install <name>@<name>` |
| Adding Bash to PreToolUse rails matcher | Hook cannot parse shell; fails open or blocks incorrectly | Keep Bash out of PreToolUse; CI gate handles it |
