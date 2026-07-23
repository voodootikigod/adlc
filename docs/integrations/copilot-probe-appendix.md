# Copilot Integration — Verified Contract Appendix (#240 probe)

> Resolves the 🧪 claims in [copilot-integration-plan.md](../copilot-integration-plan.md)
> against a **real binary**, per issue #240. This appendix is the foundation
> #242 (`plugins/adlc-copilot`) must build on. Where a plan assumption was
> wrong, the verified fact here **overrides** it.

## Probe environment

| Field | Value |
| --- | --- |
| Binary | `@github/copilot` (GitHub Copilot CLI) |
| Version | **1.0.73** |
| Platform | `darwin-arm64` |
| Evidence source | Bundled `app.js` (the shipped application) + a live example hook (`~/.copilot/hooks/superterm.json`) + **a live end-to-end deny-proof** (a real `copilot -p` model turn against a frozen rail) |
| Live model leg | **DONE (one-time proof) + re-runnable.** Ran against 1.0.73 on an entitled personal Copilot account; the live proof CORRECTED the static read of the deny mechanism (§1.1/§1.2). Made repeatable as `scripts/copilot-live-deny.mjs` (control lands the edit under `--allow-all-tools`; treatment blocks it under an explicit allowlist) — opt-in (`ADLC_COPILOT_LIVE_INSTALL=1`), not in default CI (which proves only the deny *shape*). Re-run after any Copilot CLI upgrade. (First attempts hit a feature-entitlement `403 "not authorized to use this Copilot feature"`, initially mis-surfaced as an "organization policy" denial; resolved with an entitled account.) |

Most facts below are read from the shipped implementation (static). The
**enforcement** facts (§1.1–§1.2) were additionally proven end-to-end with a
live model turn — and the live run overturned the static-only conclusion, which
is exactly why the live leg was indispensable.

## 1. Hook decision function (authoritative)

Extracted from `app.js` (`Y3t`, the function that maps a hook's parsed output
`e` to a decision):

```js
function decision(hookType, e) {
  if (hookType === "preToolUse")
    return (!e || typeof e !== "object" || Object.keys(e).length === 0)
      ? "allow" : "deny";
  if (hookType === "postToolUse") {
    if (e && typeof e === "object") {
      if (e.blocked === true) return "deny";
      if (e.modifiedResult === true) return "modify";
    }
    return "allow";
  }
  if (hookType === "permissionRequest") {
    if (e && typeof e === "object" &&
        (e.behavior === "allow" || e.behavior === "deny")) return e.behavior;
    return; // no opinion
  }
}
```

> **`Y3t` is the TELEMETRY classifier, not the enforcement path.** It labels a
> hook result `allow`/`deny`/`modify` for the `hook_end` event log. The live
> deny-proof (below) proved that emitting a non-empty object does **not** by
> itself block a tool — the real enforcement routes a "deny" through the
> permission system. Static reading alone got this wrong; the live run corrected it.

### 1.1 preToolUse deny contract — the deny is a permission *ask* (LIVE-VERIFIED)

The output **shape** is confirmed: a `preToolUse` hook signals a deny by printing
a **non-empty JSON object** whose `reason` field carries the message. `permissionDecision`
does not exist in the bundle; the exit code is not consulted. **Canonical deny for
a frozen-rail edit:** print `{"reason":"…"}` to stdout, exit 0; print nothing (or `{}`) to allow.

But the *mechanism* is a permission **ask**, not a hard block. The enforcement
site is:

```js
// the hook "deny" raises a permission request; reason → the ask message
requestHookPermission({ kind: "hook", toolCallId, toolName, toolArgs, hookMessage: a.reason });
hookProcessorResolveToolAsk(toolCallId, reason, decision?.kind, …);
```

**Live deny-proof result (real `copilot -p` turns against a frozen rail):**

| Permission mode | Rail edit via a hook `{reason}` deny |
| --- | --- |
| Default / explicit `--allow-tool <tool>` (even `--allow-tool edit`) | **BLOCKED.** Headless, the ask cannot be answered by a human, so it defaults to DENY — and it **overrides the tool allowlist.** The rail file was unchanged; Copilot reported *"the edit was blocked… cannot request confirmation in non-interactive mode."* The hook's shell classifier also blocked a `printf > file` Bash workaround. |
| `--allow-all-tools` / `--yolo` | **PROCEEDS (not blocked).** The allow-all path installs `allowAllPermissionOverride`, which auto-approves the hook's ask. The rail edit went through despite the hook emitting the correct `{reason}`. |
| Interactive | The human sees `hookMessage` (the reason) and can decline. |

**So the rails-guard hook DOES enforce rails headless — unless `--allow-all-tools`
is passed.** That single flag is the neutralizer, which is why the fleet adapter
defaults to an explicit `--allow-tool` allowlist instead of `--allow-all-tools`.

### 1.2 Fail-open only on crash or `--allow-all-tools` — CORRECTED (twice)

The original plan claimed fail-**closed** on crash ("stronger than agy/Cursor").
The static read then over-corrected to "fail-**open**, advisory-only." The live
truth is in between and precise:

| Condition | Outcome |
| --- | --- |
| Working hook deny, no `--allow-all-tools` | **Enforced** — tool blocked (overrides `--allow-tool`). |
| Working hook deny, `--allow-all-tools`/`--yolo` | **Not enforced** — ask auto-approved. |
| Hook **crashes / times out / non-zero / unparseable** | **Fail-OPEN** — no ask is raised (`hook.end` `success:false` → `decision=undefined`), so the tool proceeds under whatever the permission mode already allows. |

(The `failClosed` code paths in the binary are *enterprise managed-settings*
determination — unrelated to hook execution.)

**Design consequences for `plugins/adlc-copilot`:**
- The `preToolUse` rails-guard hook emits `{"reason":…}` and must **never crash**
  (a crash raises no ask → fail-open); internal errors are converted to a deny and
  written synchronously to fd 1 so `process.exit` can't truncate it.
- **Fleet workers must NOT use `--allow-all-tools`** (it auto-approves the deny-ask).
  The adapter defaults to `--allow-tool write --allow-tool shell` so non-rail edits
  run unattended while rail edits are blocked by the hook.
- The **unbypassable** guarantee remains the CI diff gate (`rails-guard-ci`) — it
  covers the crash and `--allow-all-tools` fail-open windows. Rate the in-session
  hook as **enforcing-when-not-allow-all, best-effort (fails open on crash)**, with
  CI as the hard tier.

### 1.3 postToolUse / permissionRequest

- `postToolUse`: output `{"blocked":true}` → deny (surfaces as a failure result
  to the LLM); `{"modifiedResult":true}` → modify. Used for the flail/anti-churn
  observer, which only needs to observe, so it emits nothing.
- `permissionRequest`: output `{"behavior":"allow"|"deny"}` — the event that
  backs an approval prompt (distinct from preToolUse).

### 1.4 Context injection (`additionalContext`) — STATIC-derived, not live-confirmed

A non-gating hook (`sessionStart`, `preCompact`, `subagentStart/Stop`) injects
narration back into the session by emitting a **top-level `additionalContext`
string**. Evidence is **static** — read from the 1.0.73 bundle, where the hook
result's `additionalContext` is consumed (`n.additionalContext`) and buffered via
`drainAdditionalContexts()` / `hookProcessorUpdateContext`. This is NOT Claude
Code's `hookSpecificOutput.additionalContext` wrapper.

**Confidence caveat:** unlike the deny path (§1.1, proven end-to-end in the live
deny-proof), context ingestion was **not** separately confirmed to surface in a
real session. `adlc-lifecycle.mjs` uses this shape for **advisory narration
only** — if Copilot consumes it differently, the narration silently no-ops; it
never causes a failure or a false gate. The capability matrix marks Copilot's
context re-injection accordingly (bundle-derived, not live-confirmed).

## 2. Hook config format (authoritative)

From the live example `~/.copilot/hooks/superterm.json`:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      { "type": "command", "bash": "'/abs/path/hook.sh' pre-tool", "timeoutSec": 5 }
    ],
    "postToolUse":  [ { "type": "command", "bash": "…", "timeoutSec": 5 } ],
    "sessionStart": [ { "type": "command", "bash": "…", "timeoutSec": 5 } ],
    "sessionEnd":   [ { "type": "command", "bash": "…", "timeoutSec": 5 } ],
    "userPromptSubmitted": [ { "type": "command", "bash": "…", "timeoutSec": 5 } ]
  }
}
```

| Plan 🧪 assumption | Verified fact |
| --- | --- |
| Hook entry `{ "type":"command", "command":"node …", "timeout":10 }` (CC shape) | Entry is `{ "type":"command", "bash":"<shell string>", "timeoutSec":<n> }`. The field is **`bash`**, not `command`; the timeout field is **`timeoutSec`**, not `timeout`. |
| `{"version":1,"hooks":{…}}` wrapper | ✅ Confirmed exactly. |

### 2.1 Stdin field names — CORRECTED

The `pre/postToolUse` hook receives JSON on stdin with **camelCase** fields.
Live-captured `preToolUse` payload (verified in the #240 deny-proof):

```json
{ "sessionId": "…", "timestamp": 0, "cwd": "/abs/repo",
  "toolName": "edit", "toolArgs": "{\"path\":\"…\",\"old_str\":\"…\",\"new_str\":\"…\"}" }
```

So the fields are `sessionId`, `timestamp`, `cwd`, `toolName` (string),
`toolArgs` (a **JSON string** that must be parsed), and for post, `toolResult`.
Not the Claude-Code `{tool_name, tool_input, tool_use_id}` snake_case shape the
plan carried over from VS Code.

**Consequence — the build-gate is inert on Copilot.** There is **no
transcript/log field** in this payload. `adlc-build-gate.mjs`'s context-fitness
check needs a session transcript (as `transcript_path` on Claude Code / Codex),
so on Copilot it always early-exits to advisory-allow and **never denies**. It
ships wired for forward-compat only; the inertness is disclosed in
`docs/integrations/copilot.md` Gaps (e) and the capability matrix. If a future
Copilot build adds a session-log field, the gate engages automatically.

## 3. Supported hook events (authoritative)

`hookProcessor*` methods + hookType string literals in the bundle confirm:

`preToolUse`, `postToolUse`, `postToolUseFailure`, `permissionRequest`,
`preMcpToolCall`, `sessionStart` (PreSession), `sessionEnd` (PostSession),
`userPromptSubmitted`, `preCompact`, `subagentStart`, `subagentStop`,
`agentStop`, `stop`, `prePrDescription`.

## 4. Discovery / load paths (authoritative)

| Primitive | Verified load paths |
| --- | --- |
| Hooks | `.github/hooks/*.json` (repo), plugin-bundled, `~/.copilot/hooks/` (user) |
| Skills | `.github/skills/`, `.agents/skills/`, **`.claude/skills/`** (repo), `~/.copilot/skills/` or `~/.agents/skills/` (personal), plugin-bundled — `SKILL.md` files. ✅ Confirms the "reads `.claude/skills`" open-standard claim. |
| MCP | `.mcp.json` or `.github/mcp.json` (workspace), `~/.copilot/mcp-config.json` (user), plugin-bundled |
| Settings | `.github/copilot/settings.json` / `settings.local.json` |
| Plugins | marketplace repo with `marketplace.json`; `copilot plugin marketplace add <source>`, `copilot plugin install <name>@<marketplace>`; also install from a GitHub repo, subdir, or git URL |

## 5. Permissions / fleet worker (authoritative)

From `copilot help permissions`:
- `--allow-tool` / `--deny-tool` take patterns `kind(argument)` where kind ∈
  `shell(command:*?)`, `write(path?)`, `<mcp-server>(tool?)`, `url(domain?)`.
- **Denial always takes precedence over allow, even `--allow-all-tools`** —
  live-verified (`scripts/copilot-live-deny.mjs`): under `--allow-all-tools
  --deny-tool shell`, a shell tool call was refused with *"Permission to run this
  tool was denied due to the following rules: `shell`"* and the side effect never
  landed.
- `--deny-tool shell` (bare kind) denies **all** shell commands → confirms the
  fleet "shell category removal" worker option.
- `--available-tools` / `--excluded-tools` filter which tools the model can see.
- Non-interactive `copilot -p "<prompt>"` needs a headless permission posture —
  **either** `--allow-all-tools`/`--yolo` (auto-approves everything, incl. hook
  deny-asks) **or** an explicit `--allow-tool <tool>` allowlist (live-verified: the
  session runs, listed tools proceed, and any unlisted tool's ask — including a
  hook's deny-ask — defaults to deny). **no JSON output mode** — text output only.

## 6. Net effect on #242

| Plan claim | Status after probe |
| --- | --- |
| Top-tier integrable (skills/agents/MCP/plugins/hooks all present) | ✅ Confirmed |
| Reads `.claude/skills` (byte-share skills) | ✅ Confirmed |
| Plugin bundles hooks/agents/skills/MCP/LSP | ✅ Confirmed |
| Deny via `permissionDecision` / exit 2 | ❌ Wrong — it's a non-empty `{reason}` object that raises a permission **ask** |
| Fail-closed on hook crash (stronger than agy/Cursor) | ❌ Wrong — but so was "fail-open advisory-only": **live-verified**, the hook deny **enforces** (blocks the tool, overrides `--allow-tool`) UNLESS `--allow-all-tools` is passed; it fails open only on hook crash or `--allow-all-tools` |
| Hook entry `command`/`timeout` (CC shape) | ❌ Wrong — `bash`/`timeoutSec` |
| stdin `{tool_name, tool_input}` | ❌ Wrong — `{toolName, toolArgs(JSON string)}` |
| Three-tier enterprise enforcement (`policy.d`, managed plugins, `strictKnownMarketplaces`) | ⏳ `strictKnownMarketplaces` present in bundle; `policy.d` string not found in this build — **defer/verify** before claiming |

**Bottom line:** Copilot is a top-tier integration whose in-session `preToolUse`
hook **does enforce rails headless** (the deny-ask defaults to deny and overrides
`--allow-tool`) — as long as the session is not run with `--allow-all-tools`,
which auto-approves the ask. `plugins/adlc-copilot` is built to that verified
contract: deny via `{reason}`, never crash (a crash fails open), the fleet adapter
uses an explicit `--allow-tool` allowlist (never `--allow-all-tools`), and the
`rails-guard-ci` diff gate is the hard backstop covering the crash / allow-all
fail-open windows.
