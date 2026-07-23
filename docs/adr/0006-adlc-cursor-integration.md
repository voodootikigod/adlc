# ADR 0006: Cursor native integration — rails-guard MVP → native parity

**Status:** **Accepted — native parity shipped.** The rails-guard MVP (P3) is
now surrounded by the full phase command suite (T16), the shared `@adlc/core`
prosecutor loop wired as the `/adlc-prosecute` sequential five-lens gate (T17),
and hook parity — the `preToolUse` dispatcher (rails-first + opt-in buildgate),
the `afterFileEdit` audit + flail piggyback, and the advisory
`beforeShellExecution` notice (T18). This ADR records the original MVP decisions
plus the T18 hook-parity pins below. The working spec is
`.adlc/specs/cursor-native-parity.md`.

**Date:** 2026-06-27
**Deciders:** Chris Williams.

> Companion to [ADR 0003](./0003-adlc-claude-code-plugin.md) (Claude Code),
> [ADR 0004](./0004-adlc-opencode-integration.md) (OpenCode), and
> [ADR 0001](./0001-codex-native-adlc-integration.md) (Codex).

## Context

ADLC already integrates with Claude Code, OpenCode, and Codex. Cursor is a major
agentic editor. The original MVP assumed Cursor **lacked a plugin marketplace** and
therefore scaffolded hooks/rules/commands into each consumer repo. **T47 updates
that premise:** Cursor now documents a first-class plugin model
(`.cursor-plugin/plugin.json`, repo marketplaces, cursor.com/marketplace). The
integration ships as a marketplace plugin (`plugins/adlc-cursor`) while keeping
the npm scaffolder as a legacy/dev fallback. Native surfaces remain **hooks**,
**rules**, **commands**, and (T47) **skills**.

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
session:            sessionStart (T64), stop, beforeSubmitPrompt (documented; default-on)
rule host:          .cursor/rules/adlc.mdc   (frontmatter: description / globs / alwaysApply)
plugin host:        .cursor-plugin/plugin.json + repo marketplace.json (T47)
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
  tool name can't slip an edit past the guard. To make this true at the *routing*
  layer (not just the decision layer), the `preToolUse` hook uses a **catch-all
  matcher (`.*`)** — every tool reaches the guard and the classifier decides; a
  narrow allowlist matcher would let a novel mutator name (`modify_file`,
  `save_file`) bypass the guard before the fail-closed classifier ran. The cost is
  one hook invocation per tool call; read-only tools return `allow` immediately.
- Corrupt `tickets.json`: `@adlc/core`'s `loadTickets` signals corruption three
  ways — it throws on some malformed schemas, returns an `errors` array on others,
  and returns an empty list when `tickets` is absent. The checker fails **closed**
  on all three (and on a resolved active ticket that isn't found, and on a
  malformed rail entry such as a non-string in the `rails` array), so a corrupt or
  truncated rail trust root cannot silently drop the declared rail set.
- Categorical fail-safe: rather than enumerate every way the deny path could throw,
  the adapter's catch is **enforcement-aware** — when `ADLC_P4_ENFORCEMENT=1`, any
  unexpected error in the decision fails **closed** (deny), because under active
  enforcement an error is likelier corruption/tamper than a benign bug; when
  enforcement is off the guard is a no-op, so it fails open to avoid bricking the
  editor. This closes the whole "exception → silent allow" class, not just the
  triggers found so far.
- Batch / MultiEdit payloads: a structured mutator can carry its paths only in
  nested `edits[]`/`files[]` arrays with no top-level scalar path. The extractor
  collects **every** target path (every path-key including a rename/move source
  *and* destination, plus nested batch items, mirroring the Claude sibling) and the
  guard denies if **any** one is a frozen rail — a single-path extractor would wave
  a MultiEdit or a rename-onto-a-rail through.
- Patch-envelope payloads: an `apply_patch`-style tool names its targets inside a
  `command`/`patch` string (`*** Update File: …`). The extractor parses those
  headers so the named paths are rail-checked. As a categorical backstop, a
  **structured mutating** tool that exposes **no inspectable path** under active
  enforcement (an opaque/unparsed format) fails **closed**. Read-only tools **and
  shell/terminal tools** are exempt from this branch: shell runs a Turing-complete
  command (e.g. `npm test`) that is intentionally not rail-gated in-session, so
  denying it would break the P4 build/test loop — its writes fall to the CI gate.
- Symlink aliasing: an edit to a symlink whose real target is a frozen rail is
  resolved (target + existing parent segments) before rail comparison and denied.
- Multi-root workspaces: in a Cursor workspace with several `workspace_roots`, the
  guard resolves the root that **owns** the edited path (longest normalized,
  symlink-resolved containment match) rather than the first listed root — for
  **relative** paths too, which are resolved against the primary root first, so a
  `../sibling-root/rail` traversal is attributed to the repo it resolves into and
  checked against the right rails (not waved through against `roots[0]`).
- Unparseable payloads: a tool payload that fails `JSON.parse` cannot be verified;
  the hook fails **closed** (deny) under active enforcement and open otherwise —
  the same enforcement-aware fail-safe as the decision path, so a malformed payload
  can't slip an edit through.

Mitigation: the unbypassable commit-time CI gate (`docs/ci/rails-guard.yml`) reads
the frozen rail set from the trusted base ref and rejects PRs that edit a
base-frozen rail regardless of how the edit was made. It is the same gate the
OpenCode and Codex integrations rely on; this ADR adds **no competing CI workflow**.

**Known scope limit (do not overstate this gate):** because the rail set is read
from the base ref, the gate protects rails **already frozen on the base branch**.
A PR that introduces a new rail *and* edits that path in the same PR is **not**
caught — the template documents this as a SECURITY LIMITATION and requires an
explicit `acknowledgedNewRailBypass` before it can serve as a required check, until
a new-rail-aware union gate ships. Same-PR protection requires freezing the rail in
a separate, already-merged commit first. The integration docs must not claim the
gate catches *every* rail edit.

## T18: hook parity — pinned decisions

Recorded 2026-07-05 (ticket T18, cursor-native-parity spec decisions 4–8).

1. **Single `preToolUse` dispatcher; rails deny always wins.** Cursor's
   multi-entry-per-event ordering and permission-combination semantics are
   **unpinned**, so a second `preToolUse` entry could mask a rails deny. The
   scaffolder wires exactly ONE `preToolUse` entry —
   `hooks/adlc-pretool.mjs` — which obtains the rails verdict by calling the
   frozen guard's exported `decide()` with the unmodified payload and returns
   any deny **verbatim**; only on rails-allow AND
   `ADLC_BUILD_GATE_ENFORCEMENT=1` does it lazily `import()` the
   `@adlc/build-gate` lib subpaths (a buildgate load failure degrades the
   buildgate only, never the rails path). A pre-T18 direct
   `adlc-rails-guard.mjs` entry is migrated to the dispatcher on re-scaffold.
2. **buildgate is advisory, DEFAULT-OFF, with NO unbypassable backstop.** The
   CI rail-freeze gate enforces rail *immutability*, not fitness-to-build;
   nothing backstops the buildgate — its depth signal is an agent-writable
   `.adlc/` file. It ships disabled behind `ADLC_BUILD_GATE_ENFORCEMENT=1`
   (bypass: `ADLC_BUILD_GATE_BYPASS=1`, honored only when durably recorded to
   the gate-manifest; risk/decide/depth/override logic imported from
   `@adlc/build-gate` deep lib subpaths — the package has no exports map, so
   `lib/*.mjs` subpaths are the sanctioned import form).
3. **Depth session-scoping (T64):** per-session counters under the user-scoped
   ADLC state dir (`~/.adlc/` or `ADLC_CURSOR_STATE_DIR`), keyed by SHA-256 of
   the unified session id. Session identity accepts docs-pinned `session_id` /
   `conversation_id` and env `ADLC_CURSOR_SESSION_ID` only (rejects
   `thread_id` / `generation_id` as session keys). Env≠payload is conflict
   (no named-state mutation). Increments are idempotent on `tool_use_id`.
   TTL (`SESSION_TTL_MS`) still expires stale session files; anonymous (no id)
   uses a TTL singleton fallback.
4. **`stop` / `beforeSubmitPrompt` are default-on (T47).** They are documented
   Cursor events; the scaffolder wires them unless opted out
   (`wireUnpinned: false` / `--no-unpinned` / `ADLC_CURSOR_WIRE_UNPINNED=0`).
5. **`beforeShellExecution` advisory never denies.** Shell is Turing-complete
   and intentionally not rail-gated in-session (threat model above);
   `hooks/adlc-shell-advisory.mjs` string-matches the command (field
   `command`, extracted defensively like the preToolUse adapter) for obvious
   writes to the active ticket's rails / trust roots and emits an
   `agent_message` reminder that the CI gate catches rail edits regardless.
   The match is **trivially bypassable** (any indirection defeats it) and
   exists only to keep an honest agent honest — it is not a control.
6. **flail piggyback (afterFileEdit) is advisory stderr only.** The audit hook
   persists a TTL-scoped recent-edits window
   (`.adlc/cursor-recent-edits.jsonl`) — Cursor hooks receive no transcript —
   and runs `@adlc/flail-detector`'s real `detectEditChurn` over it (lib
   subpath import, no local heuristic copy). Agent-writable window, no
   backstop, cannot block.

## Unverified / follow-on

- **`preToolUse` / `sessionStart` payload pins (T64):** ADLC pins
  `session_id` / `conversation_id`, `ADLC_CURSOR_SESSION_ID`,
  `workspace_roots`, `tool_name`, `tool_input`, and `tool_use_id` for the
  Cursor hooks it ships. Checked-in fixtures under
  `plugins/adlc-cursor/test/fixtures/` exercise those fields through the real
  sessionStart / preToolUse dispatchers. Live Cursor binary confirmation of
  deny delivery remains a follow-on (T68).
- **`sessionStart` `additional_context` delivery** — best-effort only. Cursor
  may accept the hook output and still drop context before the composer is
  ready; durable fallback is `rules/adlc-ticket-context.mdc`
  (`alwaysApply: true`).
- **Live deny proof** — harness under `scripts/cursor-deny-proof/`; dated
  result in T68 section above (pending maintainer run).

## T64: sessionStart + per-session control state

Recorded with `.adlc/specs/cursor-deeper-native.md`.

1. **`sessionStart` wiring** — marketplace `hooks/hooks.json` and package-root
   `hooks.json` both declare `sessionStart` → `adlc-session-start.mjs` with
   `failClosed: false` and `timeout: 10` (command path may differ by install).
2. **Consumer workspace resolution** — host-supplied `workspace_roots` +
   `CURSOR_PROJECT_DIR` only; never silent plugin-cwd fallback. Aligns
   `rails-checker.mjs` with `detectTicketStore` +
   `resolveActiveTicketAgainst(..., { allowLegacyPointer: true })`.
3. **Env pin** — returns `env.ADLC_CURSOR_SESSION_ID` when the session id is
   unambiguous; must **not** set or clear `ADLC_P4_ENFORCEMENT`.
4. **Always-apply fallback** — `rules/adlc-ticket-context.mdc` with
   `alwaysApply: true` for canonical ticket resolution when sessionStart
   context is dropped.

## T65: MCP Roots proxy (wrapper landed / channel unverified)

1. **`mcp.json`** launches `node ./bin/adlc-mcp-wrapper.mjs` — never raw
   `adlc mcp-server`. Packaging + smoke reject direct wiring.
2. **Lifecycle Roots proxy** completes initialize, requests `roots/list`,
   decodes `file://` Root URIs, runs the T64 consumer-workspace algorithm, then
   spawns `adlc mcp-server` with that cwd. Multi-active roots fail closed.
   Clients without roots capability fail closed in production (no cwd guess).
3. **Host-env** (`ADLC_CURSOR_MCP_ROOT` / `CURSOR_PROJECT_DIR`) is test-only
   (`ADLC_CURSOR_MCP_ALLOW_HOSTENV=1` on the wrapper) and does **not** unlock
   "MCP shipped."
4. **Ship gate:** installed-Cursor proof of Roots resolution (incl. multi-root
   refuse / rebind) still required before matrix/docs claim MCP shipped or T69
   marketplace publication completes. Until then: **wrapper landed / channel
   unverified.**
5. `packages/cli/lib/mcp-server.mjs` remains frozen (T65 rail).

## T66: prosecutor agents (packaged-but-unverified)

1. `plugins/adlc-cursor/agents/` ships five lenses + verifier with
   `readonly: true` (no Claude `tools:` frontmatter). Optional `prosecutor.md`
   orchestrator may set `readonly: false` for mechanical shell gates only.
2. `/adlc-prosecute` prefers Task/custom-agent fresh-context fan-out; sequential
   same-context is degraded fallback (**weaker independence**). Must not claim
   Cursor has no subagent fan-out.
3. Recorder `@adlc/prosecute` accepts core lens keys including `contract` and
   `diff`.
4. **Ship gate:** agents-backed matrix/docs claim waits on installed-Cursor
   proof of five distinct lens contexts + verifier receipt (AC10). Until then:
   **packaged-but-unverified.**

## T67: preCompact + subagent P5 policy

1. `preCompact` → `adlc-precompact.mjs` (observational ticket/rails reminder).
2. `subagentStart` / `subagentStop` → `adlc-subagent.mjs` (defense-in-depth).
3. **Authoritative** Task allowlist during P5 is on `preToolUse` via
   `lib/p5-subagent-policy.mjs` + fenced `writeP5Marker` / `readP5Marker`
   (user-scoped state dir). Session-mismatched markers ≡ absent.
4. Nested Task lineage remains **degraded/permissive** until a live lineage
   channel is proven; do not use a global anonymous marker to fake lineage.
5. Fixtures: `test/fixtures/pretool-task-*.json`, `subagent-start-prosecutor.json`.

## T68: live deny-proof harness (result pending)

**Date:** 2026-07-22 — harness landed; **live Cursor binary proof not yet run**
in this change (status: fail / pending until a maintainer records pass/fail).

- Runbook: `scripts/cursor-deny-proof/README.md` (+ `run.mjs` baseline helper).
- Binding order: pristine baseline (sentinel absent) → enforcement-on attempt →
  unchanged hash + sentinel still absent → **then** enforcement-off control.
- `failClosed` remains `false` on preToolUse regardless of outcome.
- Cursor version/platform: _pending maintainer run_.

## Consequences

Rail enforcement is real in Cursor for the common structured-edit path, with the
rail engine delegated to a single source of truth (`@adlc/core`) and the
advisory/CI two-layer model honest about what the in-session hook can and cannot
guarantee. Cursor joins Claude Code, OpenCode, and Codex with a consistent rail
contract and the same unbypassable backstop.
