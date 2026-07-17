# Spec — Claude Code MCP server + compaction-aware context (T52)

**Phase:** P1 contract for the reverse-direction port: giving
`plugins/adlc-claude-code` an MCP server and compaction-aware context hooks, mirroring
what `plugins/adlc-codex` already has.

## Problem

`plugins/adlc-codex` has a real MCP server (`plugins/adlc-codex/mcp/server.mjs` +
`.mcp.json`, wrapping `@adlc/cli/lib/mcp-server.mjs`'s `runStdioServer`) and hook
coverage for `PreCompact`/`PostCompact`/`SubagentStart`/`SubagentStop` that re-injects
ticket/rail context around compaction (`adlc-lifecycle.mjs`'s `context` mode).
`plugins/adlc-claude-code` has neither: no MCP server, and its `hooks.json` only covers
`SessionStart`/`PreToolUse`/`PostToolUse`/`Stop` — a session that compacts mid-build
loses the "ADLC current ticket: … rail protection auto-active" context injection Codex
gets automatically.

## Verified platform facts

Confirmed against the live Claude Code hooks reference (code.claude.com/docs/en/hooks) —
do not re-derive this from memory during implementation; re-check the live docs if this
spec is stale by the time T52 is built:

- Claude Code plugin manifests register MCP servers via an `mcpServers` field (either
  inline in `plugin.json` or via a referenced file), following the same convention
  documented for Claude Code plugins generally — not Codex's `.mcp.json`-file-reference
  form specifically, though the shape is compatible enough that
  `plugins/adlc-claude-code/.claude-plugin/plugin.json` gets an `"mcpServers":
  "./.mcp.json"` entry pointing at a new `plugins/adlc-claude-code/.mcp.json`, matching
  the `{ "adlc": { "command": "adlc", "args": ["mcp-server"] } }` shape Codex already
  uses (same underlying `@adlc/cli mcp-server` entrypoint, same tool surface).
- Claude Code's documented hook events include `PreToolUse`, `PostToolUse`,
  `Notification`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`, and —
  contrary to an earlier draft of this spec, which wrongly assumed otherwise —
  `PreCompact`, `PostCompact`, `SubagentStart`, and `SubagentStop` **all exist** on this
  platform. Claude Code's hook vocabulary is therefore a full superset covering the same
  compaction/subagent lifecycle events Codex already wires. This means T52 can mirror
  Codex's `adlc-lifecycle.mjs` `context` wiring exactly: `PreCompact`, `PostCompact`,
  `SubagentStart`, and `SubagentStop` all get the context-injection hook, with
  `SessionStart` retaining its existing `preflight` wiring (context injection is added
  there too, alongside preflight, not instead of it).

## Deliverables

1. `plugins/adlc-claude-code/mcp/server.mjs` — `import { runStdioServer } from
   '@adlc/cli/lib/mcp-server.mjs'; await runStdioServer();`, identical in structure to
   `plugins/adlc-codex/mcp/server.mjs`.
2. `plugins/adlc-claude-code/.mcp.json` — `{ "adlc": { "command": "adlc", "args":
   ["mcp-server"] } }`, and `plugins/adlc-claude-code/.claude-plugin/plugin.json` gains
   `"mcpServers": "./.mcp.json"`.
3. A `context` mode added to `plugins/adlc-claude-code/hooks/adlc-hook.mjs` (or a new
   focused hook file), reusing the same current-ticket-summary logic Codex's
   `adlc-lifecycle.mjs` `stateContext()` already implements, wired to `PreCompact`,
   `PostCompact`, `SubagentStart`, and `SubagentStop` in
   `plugins/adlc-claude-code/hooks/hooks.json`, plus added to the existing
   `SessionStart` entry alongside `preflight`.
4. Tests: `plugins/adlc-claude-code/hooks/test` coverage for the new context hook; an
   MCP server import/export smoke test mirroring
   `plugins/adlc-codex/mcp/test/protocol.test.mjs` where applicable.
5. Docs: `docs/integrations/claude-code.md` and
   `apps/docs/content/docs/integrations/claude-code.mdx` updated to document the MCP
   surface and compaction behavior; `plugin.json`'s description updated if it undersells
   the plugin now that it exposes MCP tools.

## Acceptance criteria

- **AC1:** `plugins/adlc-claude-code/mcp/server.mjs` exists, is wired via `mcpServers` in
  `plugin.json`, and imports cleanly. VERIFY: a smoke test analogous to
  `scripts/claude-code-plugin-smoke.mjs` asserting the MCP registration and successful
  module import.
- **AC2:** A ticket with declared rails produces the same context summary content via
  Claude Code's new `PreCompact`/`PostCompact`/`SubagentStart`/`SubagentStop` hook as
  Codex's `adlc-lifecycle.mjs` `context` mode produces for the same ticket-state
  fixture. VERIFY: a new test comparing both hooks' output against a shared fixture.
- **AC3:** `adlc rails-guard --base main --ticket T52` passes; `npm test` passes at the
  root, including both plugins' smoke tests.
- **AC4:** `plugins/adlc-claude-code/hooks/hooks.json` wires all four events
  (`PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`) to the context hook, and
  `SessionStart` still runs `preflight` alongside the new context injection. VERIFY:
  manual review of the diff against this spec plus a hooks.json presence assertion in
  the plugin smoke test.

## Out of scope

- Changing Codex's MCP server or its exposed toolset.
- T48-T51.
