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
| Evidence source | Bundled `app.js` (the shipped application) + a live example hook (`~/.copilot/hooks/superterm.json`) |
| Live model leg | **BLOCKED** on this account — org Copilot policy returns `Access denied by policy settings`; the agent loop never runs, so no tool call fires and hooks cannot be exercised end-to-end here. The live deny-proof must run in an environment with an unrestricted subscription (CI, behind `ADLC_COPILOT_LIVE_INSTALL=1`). |

All "verified" facts below are read from the shipped implementation (static),
which is authoritative for the contract shape. Only the *end-to-end* deny
behavior remains gated on the live leg.

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

And the invocation site (`hook.end`):

```js
// r is the decision; on hook failure it is undefined (no deny is applied)
let r = n.success ? decision(n.hookType, n.output) : void 0;
```

### 1.1 preToolUse deny contract — CORRECTED

| Plan 🧪 assumption | Verified fact (1.0.73) |
| --- | --- |
| Deny via stdout `{"permissionDecision":"deny","permissionDecisionReason":"…"}` **or** exit 2 | Deny via emitting a **non-empty JSON object** on stdout. The string `permissionDecision` **does not appear anywhere in the CLI bundle.** Exit code is **not** consulted for the decision. |
| Reason field `permissionDecisionReason` | The deny reason is the `reason` field of the output object; it is surfaced downstream as `hookMessage` (`{toolCallId, toolName, toolArgs, hookMessage: a.reason}`). |

**Canonical deny for a frozen-rail edit:** print `{"reason":"ADLC rail frozen: <path>"}`
to stdout and exit 0. Print nothing (or `{}`) to allow.

### 1.2 Fail-open on hook error — CORRECTED (this is the big one)

| Plan 🧪 assumption | Verified fact (1.0.73) |
| --- | --- |
| "Fail-closed on hook crash — a crashed rails-guard hook **denies** instead of letting the write through; **stronger than agy/Cursor** (both fail open)." | **FALSE.** On `success === false` (crash, non-zero exit, timeout, or unparseable stdout) the decision is `undefined`, so **no deny is applied and the tool proceeds** — i.e. Copilot hooks **fail OPEN**, the same weakness as agy and Cursor. The `failClosed` code paths in the binary belong to *enterprise managed-settings* determination, a separate mechanism unrelated to hook execution errors. |

**Design consequence for `plugins/adlc-copilot`:**
- The in-session `preToolUse` rails-guard hook is **best-effort**: it must emit a
  deny object when it intends to deny and must **never crash** (a crash = silent
  allow). Zero-dependency, defensive, wrapped so any internal error still prints
  a deny object rather than throwing.
- The **unbypassable** rail guarantee is the CI diff gate (`rails-guard-ci`) — the
  same backstop ADLC already relies on for Bash-based edits. The integration doc
  and capability matrix must state Copilot's in-session hook as **fail-open
  (advisory-tier), CI-gate as the enforcement tier** — not "stronger than agy."

### 1.3 postToolUse / permissionRequest

- `postToolUse`: output `{"blocked":true}` → deny (surfaces as a failure result
  to the LLM); `{"modifiedResult":true}` → modify. Used for the flail/anti-churn
  observer, which only needs to observe, so it emits nothing.
- `permissionRequest`: output `{"behavior":"allow"|"deny"}` — the event that
  backs an approval prompt (distinct from preToolUse).

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

The `pre/postToolUse` hook receives JSON on stdin with **camelCase** fields:
`toolName` (string), `toolArgs` (a **JSON string** that must be parsed), `cwd`,
and for post, `toolResult`. Not the Claude-Code `{tool_name, tool_input,
tool_use_id}` snake_case shape the plan carried over from VS Code.

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
- **Denial always takes precedence over allow, even `--allow-all-tools`.**
- `--deny-tool shell` (bare kind) denies **all** shell commands → confirms the
  fleet "shell category removal" worker option.
- `--available-tools` / `--excluded-tools` filter which tools the model can see.
- Non-interactive `copilot -p "<prompt>"` requires `--allow-all-tools` (or
  `--allow-all` / `--yolo`); **no JSON output mode** — text output only.

## 6. Net effect on #242

| Plan claim | Status after probe |
| --- | --- |
| Top-tier integrable (skills/agents/MCP/plugins/hooks all present) | ✅ Confirmed |
| Reads `.claude/skills` (byte-share skills) | ✅ Confirmed |
| Plugin bundles hooks/agents/skills/MCP/LSP | ✅ Confirmed |
| Deny via `permissionDecision` / exit 2 | ❌ Wrong — it's a non-empty `{reason}` object |
| Fail-closed on hook crash (stronger than agy/Cursor) | ❌ Wrong — **fail-open**, same tier as agy/Cursor |
| Hook entry `command`/`timeout` (CC shape) | ❌ Wrong — `bash`/`timeoutSec` |
| stdin `{tool_name, tool_input}` | ❌ Wrong — `{toolName, toolArgs(JSON string)}` |
| Three-tier enterprise enforcement (`policy.d`, managed plugins, `strictKnownMarketplaces`) | ⏳ `strictKnownMarketplaces` present in bundle; `policy.d` string not found in this build — **defer/verify** before claiming |

**Bottom line:** Copilot is still a top-tier integration, but its in-session
hook enforcement is **advisory (fail-open)**, not the "strongest of the seven"
the plan advertised. `plugins/adlc-copilot` must be built to that corrected
contract: deny via `{reason}`, never crash, and lean on the CI diff gate as the
real enforcement backstop.
