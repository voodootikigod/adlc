# ADR 0006: Cursor native integration — rails-guard MVP

**Status:** **Accepted — MVP shipped (P3 rail guard); command suite + prosecutor
lenses follow-on.** This ADR records the decisions for the first shippable
increment (ticket T1) and the verified facts the build rests on. The working spec
is `.adlc/cursor-spec.md`.

**Date:** 2026-06-27
**Deciders:** Chris Williams.

> Companion to [ADR 0003](./0003-adlc-claude-code-plugin.md) (Claude Code),
> [ADR 0004](./0004-adlc-opencode-integration.md) (OpenCode), and
> [ADR 0001](./0001-codex-native-adlc-integration.md) (Codex).

## Context

ADLC already integrates with Claude Code, OpenCode, and Codex. Cursor is the
remaining major agentic editor. Unlike Claude Code it has **no plugin
marketplace**, so the integration must use Cursor's native surfaces directly:
**hooks** (`.cursor/hooks.json`), **rules** (`.cursor/rules/*.mdc`), and
**commands** (`.cursor/commands/*.md`). This ADR covers the **MVP**: the
in-session rails-guard hook plus the discovery rule and a scaffolder — the
smallest increment that makes rail enforcement real in Cursor.

## Decision

Ship `plugins/adlc-cursor/` as a small Node package that wires Cursor's
`preToolUse` hook to a rail-enforcement decision, **delegating every rail / glob /
ticket primitive to `@adlc/core`** (no re-implementation — same single-source-of-
truth rule as ADR 0004). A scaffolder writes the `.cursor/` config into the user's
repo and merges into any existing hooks.

### Resolved Cursor hook facts (pinned)

```
config file:        .cursor/hooks.json   (version: 1; hooks map; per-entry
                    command / matcher / timeout / failClosed)
hook transport:     external script — JSON on stdin, JSON on stdout (NOT exit codes)
edit interception:  preToolUse   (fires before any tool, incl. Write/Edit)
  stdin:   { tool_name, tool_input: { file_path, ... }, workspace_roots, ... }
  stdout:  { permission: "allow" | "deny" | "ask", user_message, agent_message }
post-edit observe:  afterFileEdit   (fires AFTER the edit; OBSERVATIONAL — cannot block)
shell:              beforeShellExecution   (Bash writes NOT rail-gated in-session)
rule host:          .cursor/rules/adlc.mdc   (frontmatter: description / globs / alwaysApply)
```

### Enforcement honesty (the load-bearing constraint)

Cursor's in-session deny is **best-effort**, for two independent reasons:

1. `afterFileEdit` is documented as firing **after** the edit and **cannot block**
   it — so it is used only for a post-hoc audit notice, never as a control.
2. `preToolUse`'s `permission: "deny"` has **open community bug reports** of edits
   slipping through. We therefore treat the in-session hook as **advisory** and
   make the unbypassable control the commit-time CI gate
   (`docs/ci/rails-guard.yml`).

The hook is wired `failClosed: false` so a hook crash can never brick the editor;
internal adapter errors **fail open** in-session (the CI gate still catches the
edit). The one deliberate fail-closed path is a conflicting active-ticket signal,
which the checker reports as a denial.

### Rail contract (delegated, sibling-faithful)

Active ticket via `ADLC_TICKET` or `.adlc/current-ticket.json` (conflict → fail
closed); enforcement phase-gated on `ADLC_P4_ENFORCEMENT=1`; rails = the single
active ticket's `rails` plus the trust-root rails `.adlc/tickets.json` and
`.adlc/current-ticket.json`; no-op when uninitialized / off / no active ticket;
symlink targets resolved before comparison.

## Threat Model

The in-session hook is **bypassable by design** and must not be mistaken for the
control:

- The agent controls its environment, so it can leave `ADLC_P4_ENFORCEMENT` unset,
  point `ADLC_TICKET` / `.adlc/current-ticket.json` at a rail-free ticket, or
  exploit Cursor's unreliable `deny` to land an edit anyway.
- `afterFileEdit` cannot block, so a slipped edit is *observed*, not prevented.
- Bash-driven writes are not gated in-session (Turing-complete shell).
- Unrecognized mutation tools: the gate fails **closed** on tool names — only known
  read-only tools (`read`/`grep`/`codebase_search`/…) are skipped; known mutators
  and any unrecognized structured tool carrying a file path are checked, so a new
  tool name can't slip an edit past the guard.
- Symlink aliasing: an edit to a symlink whose real target is a frozen rail is
  resolved (target + existing parent segments) before rail comparison and denied.

Mitigation: the unbypassable commit-time CI gate (`docs/ci/rails-guard.yml`) reads
the frozen rail set from the trusted base ref and rejects offending PRs regardless
of how the edit was made. It is the same gate the OpenCode and Codex integrations
rely on; this ADR adds **no competing CI workflow**.

## Unverified / follow-on

- **`preToolUse` payload field names** — Cursor's public docs pin the
  `beforeShellExecution` / `beforeReadFile` contracts precisely but not the exact
  `preToolUse` `tool_input` shape. The adapter extracts the tool name and edited
  path **defensively** across the documented and sibling field names; pinning the
  exact shape against a captured real payload is pending a live install.
- **Live deny proof** — a maintainer-only end-to-end test against a real Cursor
  binary (does `permission: "deny"` actually abort the Write on the target
  platform?) remains the GA gate.
- **Command suite + prosecutor lenses** — `.cursor/commands/adlc-*` beyond
  `/adlc-init`, and the 5-lens P5 prosecution, are follow-on.

## Consequences

Rail enforcement is real in Cursor for the common structured-edit path, with the
rail engine delegated to a single source of truth (`@adlc/core`) and the
advisory/CI two-layer model honest about what the in-session hook can and cannot
guarantee. Cursor joins Claude Code, OpenCode, and Codex with a consistent rail
contract and the same unbypassable backstop.
