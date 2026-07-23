# Spec — Cursor deeper-native integration (T64–T69)

**Phase:** P1 contract for closing issue #241 Cursor gaps and making
`plugins/adlc-cursor` use Cursor’s full plugin surface (hooks, agents, MCP,
skills, commands, rules).

**Tickets:** T64 → (T65, T67, T68); T65 → (T66, T69); T66 → (T67, T69);
T67 → (T68, T69); T68 → T69. Build in that DAG order; this file is binding for
all six. Marketplace publish / `/adlc-init` DX (T69) MUST NOT proceed until
T67 (subagent hooks) and T68 (live deny-proof) are complete.

## P1 review boundary

This file is the **P1 contract**. Spec approval ships the *contract*, not the
T64–T69 implementations. Adversarial review of this artifact must judge
accuracy/completeness of the pinned decisions and acceptance criteria. Absence
of `sessionStart` wiring or other T64 code in the working tree is expected
until P4 build and is **not** a P1 no-ship reason.

**Supersedes (partially):** T47 out-of-scope items “full five-lens fresh-context
prosecutor agents” and “porting the Codex MCP server” are **in scope** here.
T47’s marketplace-primary install and CI-as-control honesty remain binding.

## Problem

`adlc-cursor` ships marketplace distribution, nine `/adlc-*` commands, two
skills, one rule, and five hook events. Cursor’s plugin model also supports
**agents**, **MCP**, and additional documented hooks (`sessionStart`,
`preCompact`, `subagentStart` / `subagentStop`). Those are unused. `/adlc-prosecute`
still claims Cursor has no subagent fan-out — stale relative to Cursor Agent
Task + plugin `agents/`. Install is still a multi-step ritual
(marketplace → global CLI → `adlc init` → CI) instead of marketplace →
`/adlc-init`. Issue #241 still tracks an unproven live `permission: "deny"`
and weak P5 independence.

## Goal

After T64–T69:

1. An installed ADLC Cursor plugin injects ticket/rails context at session
   start, exposes MCP tools, and can prosecute via fresh-context agents.
2. Hook depth matches sibling intent (compaction defense, subagent
   coordination) using only Cursor-documented events.
3. Deny honesty is evidenced (pass or fail) in ADR + matrix without marketing
   in-session deny as the security boundary.
4. Preferred UX is: install plugin → `/adlc-init` → CI rails-guard.

## Binding decisions (all tickets)

1. **CI `docs/ci/rails-guard.yml` remains the unbypassable rail control.**
   In-session `permission: "deny"` stays best-effort; `failClosed: false` on
   ADLC hooks. Never set `failClosed: true` on rails/preToolUse to “fix” deny.
2. **No invented hook events.** Only Cursor-documented Agent hooks:
   `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`,
   `postToolUseFailure`, `subagentStart`, `subagentStop`,
   `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`,
   `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`,
   `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`,
   `afterAgentThought`. This wave uses the subset named per ticket below.
3. **Do not fork `@adlc/core` rail semantics or `packages/cli/lib/mcp-server.mjs`
   allowlists** unless a later ticket explicitly owns that. Cursor adapters
   wrap; they do not reimplement.
4. **Harness-capability-matrix:** any PR that changes a
   `plugins/adlc-cursor/` capability updates the matrix cell in the same
   change when `docs/integrations/harness-capability-matrix.md` exists on the
   branch; if absent, update ADR-0006 + `docs/integrations/cursor.md` Gaps and
   leave a TODO to sync the matrix when it lands.
5. **Stale “no subagent fan-out” language** is retired only by **T66**, not by
   T64/T65 docs drive-bys.

## Pinned contracts

### Session id + env (T64)

Cursor `sessionStart` input (docs-pinned fields + ADLC-required
workspace resolution):

```json
{
  "session_id": "<string>",
  "is_background_agent": true,
  "composer_mode": "agent",
  "workspace_roots": ["<absolute path>", "..."]
}
```

(`composer_mode` optional; `session_id` is the same identifier as
`conversation_id` in Cursor’s sessionStart docs. `workspace_roots` may be
absent on some hosts — see resolution rules.)

**Consumer workspace resolution (binding):** marketplace hook commands run with
plugin cwd, so the ticket reader MUST NOT default to `process.cwd()` alone.
**Path normalization (binding):** before any existence/ADLC check, normalize
each candidate root: trim; convert Cursor Windows forms like `/c:/Users/...`
to a platform-usable absolute path; normalize separators; canonicalize when
the path exists. Deduplicate after normalization. Fixtures must include
Windows-style `workspace_roots` / `CURSOR_PROJECT_DIR` strings.

A root is **ADLC-bearing** if canonical ticket-store detection would
succeed or fail-closed (not "missing store"). Detection MUST match
`detectTicketStore` in `@adlc/tickets` (`packages/tickets/lib/store.mjs`):

- **directory** store: `.adlc/tickets/` (default for fresh repos)
- **legacy** store: `.adlc/tickets.json`
- **override** store: `ADLC_TICKET_STORE` / `ADLC_TICKETS` (or CLI equivalents)
  when set — resolve relative to that root

Hooks may reimplement the filesystem checks with Node built-ins (no
`@adlc/tickets` import required in marketplace hooks) but MUST NOT treat
"only `.adlc/tickets.json`" as the sole ADLC signal. A root with only
`.adlc/tickets/` is ADLC-bearing.

Classify each ADLC-bearing root with **one** pinned active-ticket policy after
store detection — shared by sessionStart, AC17 fallback, and Cursor rail
reader (`rails-checker.mjs` / rails-guard path). **T64 owns** aligning that
reader (remove from T64 rails freeze; add to T64 scope):

- Use `resolveActiveTicketAgainst` / equivalent with
  **`allowLegacyPointer: true`** (1.x bridge): hashless object/string pointers
  warn but resolve; a **present** `ticketHash` is always verified (stale hash
  → error-bearing). Deprecated id aliases accepted with warning.
- Do **not** use identity-only resolution that skips hash checks when a hash
  is present.
- Fixtures: hashless object, bare-string legacy, deprecated alias, valid hash,
  stale hash — agreement across sessionStart, fallback helper, and rails reader.

- **error-bearing** — any store **detection/load** failure
  (`AMBIGUOUS_STORE`, `RECOVERY_REQUIRED` / pending transactions,
  `CONFLICTING_STORE_OVERRIDE`, unreadable/corrupt store) **or** pointer/env
  conflict, malformed JSON, missing id, stale `ticketHash`, or missing ticket
  id in the store (fail-closed outcomes). Never collapse these to
  `no active ticket`.
- **active-ticket-bearing** — store loads and validates to a concrete ticket id.
- **inactive** — store loads cleanly with no active ticket (the only legitimate
  `no active ticket` case).

Build one **candidate set** = unique normalized paths from `workspace_roots`
(when present) **plus** `CURSOR_PROJECT_DIR` when set, absolute after
normalization, and ADLC-bearing (ignore non-ADLC env). Never let
`CURSOR_PROJECT_DIR` short-circuit past classification.

Then resolve **in this order**:

1. If any **error-bearing** candidates exist → select none as a silent winner;
   `additional_context` MUST report the error class + root path(s) using the
   canonical reader's detail (not the phrase `no active ticket`).
2. Else collect **active-ticket-bearing** candidates.
   - Exactly one → use it.
   - More than one → report ambiguity (every root + ticket id); no invented
     winner; not merely `no active ticket`.
3. Else collect **inactive** ADLC-bearing candidates.
   - Exactly one → use it and report `no active ticket`.
   - More than one → prefer `CURSOR_PROJECT_DIR` if in that set; else first
     `workspace_roots` entry among them; report `no active ticket`.
4. Else → **unresolved / no consumer root**. Do **not** fall back to
   `process.cwd()` (marketplace hooks often run with plugin/cache cwd, which
   may itself be ADLC-bearing). Report that no host-supplied consumer root was
   found; do **not** inject ticket context from plugin cwd.
   With a valid unified session id, **atomically replace** any prior success
   mapping with an AC19 TTL tombstone (`outcome: unresolved` / `error` /
   `ambiguous` as applicable) — do not leave a stale success root live.
   Skip index mutation only for missing identity or alias conflict.
   `process.cwd()` may be used **only** when it is independently proven to be
   a host-supplied consumer root (present in normalized `workspace_roots` or
   `CURSOR_PROJECT_DIR` after the same normalization rules) — never as a
   silent last resort.
   Tests: success→unresolved and success→error retries through the real
   fallback helper (Verify: `node --test plugins/adlc-cursor/test/*.test.mjs`).

Unit/wire tests cover (AC4): zero roots with an ADLC-bearing plugin cwd that
is never selected; one active; longer inactive vs shorter
active; multi-active ambiguity; env inactive + other active; env active +
second active (ambiguity); malformed pointer / env-pointer conflict / stale
hash / missing ticket (error-bearing, not `no active ticket`); Windows-style
`/c:/...` roots that still resolve; **directory-only** store
(`.adlc/tickets/` without `tickets.json`); dual-store ambiguity
(both exist → error-bearing); pending-transaction / recovery-required fixture;
override-store fixture.
Verify: `node --test plugins/adlc-cursor/test/session-start.test.mjs`


`sessionStart` output used by ADLC:

```json
{
  "env": {
    "ADLC_CURSOR_SESSION_ID": "<session_id>"
  },
  "additional_context": "<markdown summary>"
}
```

- Env key name is exactly `ADLC_CURSOR_SESSION_ID` (no aliases).
- **Session identity extractor (binding):** accept only docs-pinned
  `session_id` / `conversation_id` aliases (and env
  `ADLC_CURSOR_SESSION_ID`). **Reject** `generation_id`, `thread_id`, and
  other non-session fields as session keys (generation-only payload → anonymous
  or conflict per tests — never treat as a named session). If multiple accepted
  aliases are present, they MUST normalize to the same value after trim;
  disagreement → **terminal conflict** (no named-state mutation, **no**
  anonymous fallback for that event). Resolve order otherwise:
  1. Env≠payload (accepted aliases) after trim → conflict as above.
  2. Else non-empty env `ADLC_CURSOR_SESSION_ID`.
  3. Else unified payload session id.
  4. Else anonymous / no-id (TTL singleton) only when no accepted alias present.
  Shared resolver for sessionStart and downstream hooks. Tests: env=A/payload=B
  (stores unchanged); `session_id`≠`conversation_id`; generation-only;
  duplicate `tool_use_id` + P5 isolation
  (Verify: `node --test plugins/adlc-cursor/test/*.test.mjs`).
- **Per-session depth state (binding):** Prefer **one state file per session
  id**. **Storage root (binding):** all named-session **control state** (depth,
  seen-id set, P5 marker) lives under the **user-scoped** ADLC state dir
  (`~/.adlc/` or `ADLC_CURSOR_STATE_DIR`) keyed by `safeId` — **not** under
  the consumer workspace. Workspace-resolution records (AC19) are separate and
  may change outcome/tombstone without relocating or resetting control state.
  File name e.g. `cursor-buildgate-depth-<safeId>.json`. Tests: one session
  interleaved across two `workspace_roots` shares one counter; success→
  unresolved→success keeps depth monotonic and P5 marker visible.
  **`safeId` (binding):** collision-resistant fixed encoding of the exact
  session id — SHA-256 hex of the UTF-8 session string (not lossy sanitization).
  Validate the resolved path stays under `.adlc/` (reject traversal). Tests cover traversal-shaped ids and two distinct ids that would collide under
  a lossy sanitizer, proving independent depth/marker state
  (Verify: `node --test plugins/adlc-cursor/test/*.test.mjs`).
  **Increment must be an atomic read-modify-write** — prefer CAS with retry
  (compare expected count / generation, rewrite, retry on conflict), or a file
  lock that includes: an ownership token, `try/finally` release, **bounded**
  acquire timeout/backoff, and **stale-lock reclamation** via a lease
  timestamp (a dead holder must not wedge forever). **Fencing (binding):**
  before committing the new depth/seen-id state, revalidate ownership or a
  fencing generation; if the lease was reclaimed or the generation advanced,
  abort the write and retry the full RMW. A paused holder that resumes after
  another process reclaimed must not overwrite the newer commit. Temp-file +
  rename alone only prevents torn writes and is **not** sufficient for
  concurrent increments. A naïve shared-map RMW without lock/CAS is
  unacceptable.
  Do not use a single top-level `{ count, conversationId }` that resets when
  the active id changes. TTL (`SESSION_TTL_MS`) expires **stale session
  entries** / files; it is not a substitute for per-id isolation.
  When no session id is available, keep a single anonymous TTL-scoped counter
  with the same atomic RMW + lease rules.
- **Idempotent logical bumps (binding):** Cursor `preToolUse` payloads carry a
  tool-use identifier (`tool_use_id` / docs-pinned equivalent once captured).
  Depth counts **logical tool calls**, not hook deliveries. Key increments by
  `(sessionId, tool_use_id)` when `tool_use_id` is a non-empty string.
  Under the same CAS/leased lock, retain a TTL-bounded seen-id set; a duplicate
  delivery for an already-seen id MUST NOT increment. **Missing / empty /
  non-string `tool_use_id`:** count as a distinct per-delivery bump (no shared
  synthetic key — that would freeze depth); do not invent stable ids. Fixtures
  cover present, duplicate, missing, null, and wrong-type. Sequential and
  concurrent duplicate delivery (same id → single increment) required.
- Interleaving proof required in tests: successive bumps
  A1, B1, A2, B2 → depths **1, 1, 2, 2**.
- Concurrency proof required: synchronized multi-process bumps with no lost
  updates; a crash-recovery test that kills a lock holder mid-hold and
  verifies the next increment recovers (reclaims stale lease) without hanging
  or permanently undercounting; **plus** a paused-holder race where holder A
  reads, pauses past lease expiry, holder B reclaims and commits, then A
  resumes and must retry (not overwrite B).
- Preflight / flail session markers SHOULD follow the same per-id preference
  when they key session-ness; minimum bar for T64 AC is the depth counter.
- `additional_context` must include: active ticket id **or** the exact phrase
  `no active ticket`; whether enforcement is active; a one-line pointer
  to `/adlc-*` / the `adlc` skill. **Enforcement (binding):** active iff
  `process.env.ADLC_P4_ENFORCEMENT === "1"` (match `rails-checker.mjs`);
  values `0`, `false`, empty, or unset are **not** enforcing. “Phase hint” =
  map from ticket presence + that boolean to `idle` | `ticketed` |
  `enforcing`. Tests cover absent, empty, `0`, `false`, and `1`.
- **`sessionStart` MUST NOT set or clear `ADLC_P4_ENFORCEMENT`.** It only
  reports whether the flag is already set. Auto-enabling enforcement from the
  plugin is out of bounds (parallax resolution + premortem).
- **User-scoped session-resolution record (T64):** on every **terminal**
  resolution with a valid unified session id, atomically write either a
  success record or the corresponding AC19 TTL tombstone (error / ambiguous /
  unresolved). Skip mutation only for missing identity or alias conflict.
  Owned by T64 for hooks/AC17; **not** an MCP root channel until session-id
  handoff is evidenced.
- Scaffold path: `mergeHooks` in `plugins/adlc-cursor/lib/scaffold.mjs` (in
  T64 scope) must wire `sessionStart` with the same relative /
  `node_modules/@adlc/cursor` command rules as other ADLC hooks.


### sessionStart delivery honesty (T64)

Cursor docs accept `additional_context` on `sessionStart`, but there is a
community-reported race where the host accepts the hook output and still drops
the context before the composer is ready
(https://forum.cursor.com/t/sessionstart-hook-additional-context-is-never-injected-into-agents-initial-system-context/158452).
Therefore:

1. `additional_context` injection is **best-effort**, not a guaranteed control.
2. T64 MUST ship a **dedicated** minimal plugin rule (e.g.
   `rules/adlc-ticket-context.mdc`) with **`alwaysApply: true`** that directs
   the agent to resolve the active ticket via the **canonical** reader
   semantics (same fail-closed outcomes as `generated-active-ticket.mjs` /
   sessionStart classification: env-pointer conflict, stale hash, malformed
   pointer, missing ticket, multi-root ambiguity). It MUST NOT treat a raw
   `.adlc/current-ticket.json` read or raw `ADLC_TICKET` as authoritative by
   itself. Prefer pointing the agent at a documented helper
   (`adlc` subcommand or packaged script) that applies those semantics.
   Extending `rules/adlc.mdc` alone is **not** sufficient while it remains
   `alwaysApply: false`.
3. Scaffold upgrade path: install if missing. Upgrade **only** when the on-disk
   file **byte-matches a known stock hash** (pinned in the package) **or** when
   only a delimited managed block (sentinel `BEGIN/END ADLC_TICKET_CONTEXT_V<n>`)
   differs and surrounding user text is preserved. If the file contains the
   sentinel but does **not** match stock / managed-block expectations (user
   edits), do **not** overwrite: keep the file, emit a scaffold warning, and
   write a sibling proposal (e.g. `adlc-ticket-context.mdc.adlc-proposed`) or
   `.bak` backup. Tests must cover a sentinel-bearing user-modified file that
   is preserved.
4. Docs/ADR MUST say sessionStart context is best-effort and name the
   always-apply fallback rule file.
5. AC4 remains a unit test of hook JSON shape; **AC17** covers the always-apply
   rule frontmatter + scaffold install/upgrade. A live marketplace IDE proof is
   nice-to-have, not a hard T64 AC.

### Hook wiring defaults

Plugin `hooks/hooks.json` and package-root `hooks.json` stay in lockstep (or
one is generated from the other — no drift). Scaffold `mergeHooks` gains the
new events with the same relative-command / `node_modules` rules as T47.

| Event | Script | Ticket |
| --- | --- | --- |
| `sessionStart` | `hooks/adlc-session-start.mjs` | T64 |
| existing five | unchanged roles | — |
| `preCompact` | `hooks/adlc-precompact.mjs` | T67 |
| `subagentStart` / `subagentStop` | `hooks/adlc-subagent.mjs` (shared) | T67 |

All new entries: `timeout: 10`, `failClosed: false`. Marketplace vs
scaffold/package-root command path policy is T47-compatible (see AC2) —
semantic lockstep, not identical command strings.

### MCP (T65)

`plugins/adlc-cursor/mcp.json` MUST launch the **plugin wrapper**, not
raw `adlc mcp-server` (direct wiring is a packaging/smoke failure):

```json
{
  "mcpServers": {
    "adlc": {
      "command": "node",
      "args": ["./bin/adlc-mcp-wrapper.mjs"]
    }
  }
}
```

Exact relative wrapper path may be `./bin/...` or `./lib/...` under
`plugins/adlc-cursor/` as shipped — smoke asserts the entry invokes the
wrapper module, not `["mcp-server"]` on the `adlc` binary. The wrapper
resolves consumer root then `spawn`s `adlc mcp-server` with that cwd.
Document that a missing `adlc` on PATH yields Cursor’s normal MCP start
failure; skills/README tell the user to `npm i -g @adlc/cli`.

**Consumer workspace for MCP (binding):** `packages/cli/lib/mcp-server.mjs`
today scopes gates to `process.cwd()`. Marketplace MCP may not launch with the
consumer repo as cwd. T65 ships a plugin entry under `plugins/adlc-cursor/`
that invokes `adlc mcp-server` only after resolving a consumer root.
Do **not** edit `packages/cli/lib/mcp-server.mjs` (frozen by T65 rails).
Do **not** silently leave MCP on plugin-cache cwd. Expanding `ALLOWED_GATES`
remains out of scope.

**Shipped MCP architecture (binding):** the **lifecycle-aware MCP Roots
proxy** is **mandatory** to claim MCP shipped / unlock T69 publication. A thin
host-env-only wrapper may land for development and unit tests but **cannot**
alone unlock the shipped claim — it cannot detect multi-root when only
`CURSOR_PROJECT_DIR` is present. AC7's installed-Cursor ship gate must prove
Roots-based resolution (including a multi-root case that refuses ambiguous
launch or selects via the sessionStart algorithm). Thin-wrapper host-env proofs
alone are insufficient.

**Production root channel (binding — not test-only inject):** a **thin
pre-spawn wrapper** cannot call MCP `roots/list` before the child server
exists (`roots/list` is post-initialize). Do **not** claim Roots as a
pre-spawn source unless T65 ships a **lifecycle-aware MCP proxy** that
completes initialize, requests Roots, then forwards to `adlc mcp-server`.

**Mandatory shipped path (T65 lifecycle proxy):** after initialize, negotiate
capabilities; if client lacks roots, fail closed (do not fall back to guessing
cwd). Request `roots/list`; decode each Root `uri` from `file://`
(percent-decoding; Windows `file:///C:/...` / `file://localhost/C:/...`
forms) into normalized absolute paths before the sessionStart algorithm.
If `listChanged` is false, still fail closed on any observed root drift that
cannot be refreshed. On `notifications/roots/list_changed` (when supported):
stop accepting new tool calls, re-request/reclassify Roots, fail closed on
ambiguity, drain/terminate the old child, rebind (generation-bound) before
resuming; in-flight calls must not mutate the stale root. Expanding
`ALLOWED_GATES` or editing frozen `mcp-server.mjs` remains out of scope.
AC7 fixtures must use real `roots/list` Root objects (not bare path strings).

Thin host-env wrapper may exist for local/dev unit tests only — not for
"MCP shipped." T64 session-resolution records remain for hooks/AC17, not as
MCP root channel until session-id handoff is evidenced.

**Production MCP root (binding):** shipped path is the lifecycle Roots proxy
(see above). Session-resolution records are not an MCP root channel until
session-id handoff is evidenced. Thin host-env helpers are test-only.

AC7 unit/subprocess MUST include: (a) host-env success without session id or
cwd heuristics; (b) absent host env → fail closed even if cwd is ADLC-bearing
(unrelated repo / plugin checkout). **Production ship gate (binding):** do not
mark Cursor MCP as shipped in matrix/docs and do not complete T69 publication
until an **installed-Cursor** proof records that the lifecycle Roots proxy
resolves a consumer root (incl. multi-root ambiguity/refuse) without
harness-injected env. Until that proof, MCP remains "wrapper landed / channel
unverified." Host-env-only thin wrapper does not unlock shipped. Session-index MCP
fallback stays locked until session-id handoff is evidenced.

AC7 verification MUST launch through the **shipped `mcp.json` entry**
(not a test-only argv root). Required now: host-env success; absent host env
fails closed (even with ADLC-bearing unrelated cwd / plugin checkout); wrong
repo must not win. If a lifecycle Roots proxy is shipped, also cover
zero/one/multi-root Roots cases. Session-index MCP cases are **out of AC7**
until live session-id handoff evidence is recorded — do not require them.

### Agents + prosecute (T66)

Ship under `plugins/adlc-cursor/agents/` (register `"agents": "./agents/"` in
`.cursor-plugin/plugin.json`):

| File | Role |
| --- | --- |
| `prosecutor-correctness.md` | Lens 1 |
| `prosecutor-security.md` | Lens 2 |
| `prosecutor-contract.md` | Lens 3 |
| `prosecutor-diff.md` | Lens 4 |
| `prosecutor-tests.md` | Lens 5 |
| `prosecutor-verifier.md` | Verifier |
| `prosecutor.md` (optional) | Orchestrator / mechanical gates |

Frontmatter (Cursor subagent format — see https://cursor.com/docs/subagents):

- Required on **every lens and verifier** agent: `name`, `description`,
  **`readonly: true`**.
- Do **not** copy Claude Code `tools: Read, Grep, Glob` (or any `tools:`) —
  that is not Cursor agent syntax and does not enforce read-only. Unsupported
  fields may be ignored while the agent inherits mutating + MCP capabilities.
- Optional `prosecutor.md` orchestrator may set `readonly: false` **only** if
  it must run mechanical shell gates; the file must document why.
- Packaging/smoke tests **reject** any lens/verifier agent missing
  `readonly: true`.

Adapt prompt bodies from `plugins/adlc-claude-code/agents/`; do not invent a
third convergence implementation — keep `@adlc/core` prosecutor semantics;
command body orchestrates Task/agent fan-out.

**Evidence lens vocabulary (binding):** `@adlc/core` lens keys are
`correctness`, `security`, `contract`, `diff`, `tests`. The
`adlc prosecute` recorder (`packages/prosecute/lib/schema.mjs`) must accept
those keys. T66 MUST either extend the recorder `LENSES` set to include
`contract` and `diff` (preferred; add `packages/prosecute/**` to T66
scope) **or** document a lossless mapping table in the command and prove a
full five-pass packet validates through the real recorder. AC10 must run a
generated packet through `validateInput` / `adlc prosecute` — string
asserts alone fail.

`/adlc-prosecute` must:

1. Prefer Task (or Cursor custom-agent) fan-out: one fresh context per lens,
   then verifier.
2. Document sequential same-context as **degraded fallback** only.
3. **Not** contain the claim that Cursor has no subagent fan-out.
4. Still require `npx adversarial-review --providers` for the cross-model
   risk gate on risk-tiered changes.
5. Before fan-out, write P5 marker (see T67); clear it on completion/abort
   best-effort.

### P5 marker + subagent policy (T67)

- Marker path: prefer **per-session** files
  `cursor-p5-marker-<safeId>.json` using the same SHA-256 `safeId`
  encoding as depth counters. **Storage root (binding):** user-scoped state dir only (same as depth —
  `~/.adlc/` / `ADLC_CURSOR_STATE_DIR`), never consumer `.adlc/`. Command
  write, `preToolUse`, and `subagentStart` MUST agree — tests where command
  cwd, plugin cwd, and ticket root differ must observe the same marker. Shape:
  `{ "ts": <number>, "ticketId": "<id>", "sessionId": "<string>", "runId": "<string>" }`.
  `runId` is unique per prosecute invocation. All marker write/replace/delete
  uses the **same leased, fenced lock** as depth state. Cleanup re-reads under
  the lock immediately before delete and compare-and-deletes on matching
  `runId` only. Overlapping same-session runs: reject second start **or**
  replace with new `runId` such that only the owner may clear. Barrier test:
  A reads for cleanup, pauses, B replaces, A resumes → must not delete B.
- `subagentStart` applies allowlist policy **only** when a fresh marker exists
  **for this session** (`marker.sessionId` equals the resolved
  `ADLC_CURSOR_SESSION_ID` / payload session id). Mismatched sessionId ≡
  absent (session B must not inherit session A's prosecution restrictions).
- Absent, mismatched, or TTL-stale marker → **allow** all subagent types
  (never brick the editor). A crashed prosecute must not brick other sessions
  or this session after TTL — stale ≡ absent.
- Fresh matching marker → allowlist prosecutor agent `name`s (and
  `generalPurpose` / `explore` only if the prosecute command explicitly uses
  them). Unrelated types/names under a fresh matching marker → `ask` or
  `deny` (not silent allow). Absent/mismatched/stale marker still allows
  ordinary types (do not brick the editor).
- **Nested subagent lineage (binding):** Cursor currently may give child
  `preToolUse` a fresh conversation id with no parent link, while
  `subagentStart` still sees the parent — so a parent-session marker is not
  reliably visible on the authoritative child path. **Until** a demonstrated
  lineage channel or host control that disables nested Task is pinned +
  fixture-proven: nested Task during P5 is **explicitly degraded / permissive**
  (document in ADR); do **not** use a shared anonymous/global marker to fake
  lineage (that would restrict unrelated anonymous sessions). Agents-backed
  publication remains blocked (AC10 ship gate) until lineage or nested-disable
  is proven with a live canary. Two concurrent anonymous sessions must not
  share P5 restrictions.
- **Enforcement path (binding):** Cursor has reported that `subagentStart`
  `deny` may not stop the subagent from running. The **authoritative**
  allowlist for Task/subagent spawn during P5 MUST also be enforced on
  `preToolUse`, with `subagentStart` retained only as defense-in-depth.
  **Task payload pin (binding):** check in docs-pinned or captured fixtures under
  `plugins/adlc-cursor/test/fixtures/` for `preToolUse` Task/spawn and
  `subagentStart`, naming the exact `tool_name` and agent-name / subagent-type
  fields used in production. Allowed prosecutor + unrelated-agent cases run
  through the real dispatcher. T68 live proof must show a rejected Task spawn
  (version/platform recorded); if `subagentStart` alone is insufficient,
  `preToolUse` remains the control and ADR notes the degradation.
- Anonymous sessions (no session id): use a separate
  `.adlc/cursor-p5-marker-anonymous.json` fallback with the same TTL rules;
  never let an anonymous marker restrict a named session or vice versa.
- `/adlc-prosecute` clears **this session's** marker best-effort on completion
  and on documented abort paths.
- Tests: session A marker must not change session B `subagentStart` allow
  decisions.
- `preCompact` is observational: `user_message` reminding of active ticket +
  rails; cannot block compaction.

### Live deny-proof (T68)

Maintainer-run harness under `scripts/cursor-deny-proof/` (or
`scripts/cursor-deny-proof.mjs` + README). Manual /
`workflow_dispatch`-only if CI-wrapped. Results dated in ADR-0006 with Cursor
version. Matrix cell updated in the same PR when the matrix file exists.
**Never** flip `failClosed` to true based on proof outcome.

Checklist minimums (false-confidence guard): `ADLC_P4_ENFORCEMENT=1`, a
resolved active ticket that declares at least one rail, a structured Write/Edit
targeting that rail path with a **unique sentinel** payload, recorded tool
deny/allow observation plus Cursor version, **and** before/after content
hashes proving the rail file bytes are **unchanged** after the denied attempt.
Ordering (binding): pristine baseline (sentinel absent) → enforcement-on
attempt → unchanged hash + sentinel still absent → **then** enforcement-off
control mutates. Reversing order can make an executed deny look like a no-op.
A run that only logs a deny without this ordering is not a proof. A fixture
that omits enforcement or never edits a rail is not a proof.

### Install DX (T69)

`/adlc-init` + `skills/adlc-init` become the single onboarding narrative:

1. Detect `adlc` on PATH (else print `npm i -g @adlc/cli`).
2. `adlc init --harness cursor`.
3. Point at `docs/ci/rails-guard.yml` as required check.
4. Do not require `npx @adlc/cursor` for normal users; scaffolder remains for
   contributors / local-dev.

Human `cursor.com/marketplace/publish` checklist lives in docs; docs must not
fabricate a live marketplace URL before submission succeeds.

Optional (in-scope if cheap): thin `alwaysApply: true` rule “ADLC plugin is
active”; Cursor CLI `statusLine` snippet reading
`.adlc/current-ticket.json` documented (not required for AC).

## Deliverables by ticket

### T64

1. This spec (author before code).
2. `hooks/adlc-session-start.mjs` + hooks.json wiring + scaffold merge
   (`lib/scaffold.mjs`).
3. User-scoped per-session **control-state helpers** (depth + seen-id + fenced
   P5 marker) under `~/.adlc/` / `ADLC_CURSOR_STATE_DIR`; TTL; anonymous
   fallback; idempotent on `tool_use_id`.
4. Upsert versioned **session-resolution records** / TTL tombstones (AC19)
   under whole-index lock/CAS; concurrent upsert + ordering + TTL tests.
4b. Align `rails-checker.mjs` / rails-guard active-ticket path with pinned
   store detection + `allowLegacyPointer: true` (T64 scope; not frozen).
5. Dedicated `alwaysApply: true` ticket-context rule + scaffold upgrade path
   (`plugins/adlc-cursor/rules/**` in T64 scope); ADR/docs mark sessionStart
   context as best-effort.
6. Checked-in fixtures under `plugins/adlc-cursor/test/fixtures/` (or
   equivalent) for docs-pinned `sessionStart` and `preToolUse` payloads
   including `tool_name` / `tool_input` / `workspace_roots` / `tool_use_id`;
   run them through the real extractor/dispatcher; ADR-0006 retires the matching
   “unverified” payload bullets when pinned.
7. Fix stop/preflight “DISABLED BY DEFAULT” comments.
8. Smoke + unit tests (AC below).

### T65

1. `mcp.json` launching the **lifecycle Roots proxy** (mandatory for ship) +
   packaging allowlist + plugin discovery. Thin host-env wrapper may exist for
   unit tests only and must not unlock "MCP shipped."
2. Skills/docs mention `adlc_gate` / `adlc_prosecute` and the root boundary.
3. Matrix/docs MCP cell → shipped.
4. Implement consumer-root selection via plugin wrapper only; leave
   `mcp-server.mjs` frozen; do not claim session-index MCP fallback until session-id handoff is
   evidenced; exercise host-env (and optional Roots proxy) in AC7. Reject
   direct `adlc mcp-server` mcp.json wiring in smoke.

### T66

1. `agents/` roster + plugin.json.
2. Rewrite `command/adlc-prosecute.md` for five-lens+verifier fresh fan-out,
   fail-closed verifier, convergence, and `adlc prosecute` evidence recording;
   smoke asserts those strings (not prose-only Task mention).
3. Matrix/docs P5 independence cell → agents-backed (+ providers caveat) only
   after AC9/AC10 pass.

### T67

1. preCompact + subagent hooks using the **T64** fenced P5 marker helper
   (no second marker implementation).
2. ADR pin + smoke; barrier tests for overlapping cleanup.

### T68

1. Deny-proof runbook/harness + dated ADR/matrix evidence.
2. Gaps section updated.

### T69

1. `/adlc-init` one-flow + marketplace publish checklist honesty.
2. Docs/integration-facts marketplace-first including agents+MCP once landed.
3. Blocked on T67 + T68 (and transitively earlier wave tickets) — do not publish
   or claim wave-complete until those gates land.
4. Do not claim MCP shipped or complete marketplace publication until AC7's
   installed-Cursor production-channel proof is recorded.
5. Do not claim agents-backed P5 until AC10's installed-Cursor agent fan-out
   proof is recorded.

## Acceptance criteria

- **AC1 — umbrella spec:** `.adlc/specs/cursor-deeper-native.md` exists and
  names T64–T69 with the binding decisions above.
  Verify: `node scripts/cursor-install-smoke.mjs .` asserts the spec path is
  present (or a packaging test references it); `test -f .adlc/specs/cursor-deeper-native.md`.
- **AC2 — sessionStart wired (semantic lockstep):** both
  `plugins/adlc-cursor/hooks/hooks.json` (marketplace) and package-root
  `plugins/adlc-cursor/hooks.json` declare `sessionStart` with
  `failClosed: false` and `timeout: 10`, targeting `adlc-session-start.mjs`.
  **Command strings may differ by install path:** marketplace uses
  `node ./hooks/adlc-session-start.mjs`; package-root / scaffolded project hooks
  use the existing T47 policy
  (`node "./node_modules/@adlc/cursor/hooks/adlc-session-start.mjs"` when
  project-local, else absolute scaffolder path). Smoke must assert event
  presence + options lockstep, not identical command strings.
  Verify: `node scripts/cursor-install-smoke.mjs .`
- **AC3 — per-session depth counters:** With distinct session ids A and B,
  interleaved bumps A1,B1,A2,B2 yield depths 1,1,2,2 (independent counters).
  Concurrent multi-process bumps of the same id lose no increments
  (CAS-with-retry or leased lock with stale reclaim + fencing before commit;
  rename-only insufficient); killing a lock holder must not wedge later bumps;
  paused-holder-after-reclaim must not overwrite. Increments are idempotent
  on `tool_use_id` (duplicate delivery → single bump; sequential + concurrent
  duplicate fixtures required). `safeId` is SHA-256 hex with path containment;
  traversal-shaped and sanitizer-collision ids must not share state. TTL expires
  stale session entries and seen-id records. Anonymous (no id) keeps a TTL singleton fallback. Env `ADLC_CURSOR_SESSION_ID` is preferred only when payload id is absent or
  equal; env≠payload is conflict (no named-state mutation) — not "prefer env".
  Verify: `node --test plugins/adlc-cursor/test/*.test.mjs`
- **AC4 — sessionStart context + env:** sessionStart stdout
  `additional_context` includes the active ticket id when the pointer resolves
  in the **resolved consumer workspace**; includes the exact phrase
  `no active ticket` when an inactive ADLC root is selected; reports
  unresolved/error/ambiguity without selecting plugin cwd. Returned `env` must
  set `ADLC_CURSOR_SESSION_ID` exactly to the input `session_id` when present
  and unambiguous, and must **not** set or clear `ADLC_P4_ENFORCEMENT`.
  Env≠payload conflict: report conflict; prove depth, seen-id, P5 marker, and
  session-index stores for A and B remain unchanged. Wire tests drive the real
  dispatcher with returned env for a downstream depth bump; cover missing ids. Use cwd=plugin dir with 0/1/N ADLC workspace
  roots (zero-root must use an ADLC-bearing plugin cwd and prove it is never
  selected), including directory-store and dual-store error fixtures.
  Verify: `node --test plugins/adlc-cursor/test/session-start.test.mjs` (temp dirs).
- **AC5 — ADR + comment truth:** ADR-0006 treats `session_id` /
  `ADLC_CURSOR_SESSION_ID` as pinned; stop/preflight source headers do not say
  `DISABLED BY DEFAULT`.
  Verify: `node scripts/cursor-install-smoke.mjs .` (ripgrep asserts).
- **AC6 — rails + tests:** `adlc rails-guard --base main --ticket T64` passes;
  plugin unit tests pass.
  Verify: `adlc rails-guard --base main --ticket T64` and
  `node --test plugins/adlc-cursor/test/*.test.mjs`
- **AC7 — mcp.json + consumer root channel:** `plugins/adlc-cursor/mcp.json`
  points at the wrapper/proxy; packaging includes mcp config + entry.
  Thin-wrapper path: host-env single root only (no cwd heuristic, no session
  index in AC7). Multi-root: lifecycle proxy with Roots, or fail closed.
  Unit/subprocess: host-env success; absent host env fails closed even when
  cwd is an unrelated ADLC-bearing repo or plugin checkout; if proxy shipped,
  zero/one/multi-root Roots cases; `adlc_gate` / `adlc_prosecute` hit temp
  fixtures when root resolves there (wrong-repo / plugin cwd must not win).
  **Ship gate:** matrix/docs must not claim MCP shipped, and T69 must not
  publish, until installed-Cursor proof shows the **Roots proxy** resolves
  consumer root (incl. multi-root refuse/ambiguity and root-change rebind /
  stale-child isolation) without harness injection (ADR dated pass/fail +
  Cursor version). Host-env-only thin-wrapper proofs do not unlock shipped.
  Verify: `node --test plugins/adlc-cursor/test/*.test.mjs`;
  `node scripts/cursor-install-smoke.mjs .`; live-proof/ADR asserts for
  production channel.
- **AC8 — mcp-server frozen:** `packages/cli/lib/mcp-server.mjs` is unchanged
  by T65. Consumer-root selection is implemented by a **plugin wrapper** under
  `plugins/adlc-cursor/` that sets cwd (or equivalent) before launching
  `adlc mcp-server` — not by editing the frozen server.
  Verify: `adlc rails-guard --base main --ticket T65` (rail covers
  `packages/cli/lib/mcp-server.mjs`).
- **AC9 — prosecutor agents roster:** Exact shipped files
  `prosecutor-correctness.md`, `prosecutor-security.md`,
  `prosecutor-contract.md`, `prosecutor-diff.md`, `prosecutor-tests.md`,
  and `prosecutor-verifier.md` exist under `plugins/adlc-cursor/agents/`,
  are included in packaging, with valid `name` + `description` frontmatter
  and **`readonly: true` on every lens and verifier** (no Claude `tools:`
  frontmatter). Packaging rejects missing `readonly: true` on those roles.
  Packaging/smoke alone may mark agents as **packaged**; matrix/docs must not
  claim **agents-backed** prosecution until AC10's installed-Cursor ship gate
  passes.
  Verify: `node --test plugins/adlc-cursor/test/packaging.test.mjs` and
  `node scripts/cursor-install-smoke.mjs .`
- **AC10 — Task prosecute semantics:** `/adlc-prosecute` requires
  Task (or Cursor custom-agent) fan-out of the **five lenses then verifier**
  in **fresh contexts**; documents sequential same-context as degraded
  fallback only; does not claim Cursor has no subagent fan-out; keeps
  `adversarial-review --providers` for the cross-model risk gate; instructs write/clear of the session-matched P5 marker via the **T64 fenced
  marker helper** (hooks in T67 call the same helper); and requires recording
  ticket- and revision-bound prosecution evidence via `adlc prosecute` /
  `adlc_prosecute` (gate-manifest), including fail-closed verifier handling
  and shared convergence (`@adlc/core` prosecutor semantics — no third
  implementation). A fixture five-pass packet (core lens keys, including
  `contract` and `diff`) must validate through the real recorder
  (`validateInput` / prosecute path); missing any required lens fails.
  Prose-only Task mention fails this AC.
  **Ship gate:** installed-Cursor proof invokes every packaged lens + verifier
  by exact agent `name`, records distinct subagent/context ids for five fresh
  lens runs, and proves the verifier receives all five results (dated ADR +
  Cursor version). Until then matrix/docs say packaged-but-unverified, not
  agents-backed.
  Verify: `node scripts/cursor-install-smoke.mjs .`; `node --test
  plugins/adlc-cursor/test/*.test.mjs` (packet through recorder);
  live-proof/ADR asserts for agent fan-out.
- **AC11 — compaction/subagent hooks:** `preCompact`, `subagentStart`, and
  `subagentStop` are present in default plugin `hooks/hooks.json`.
  Verify: `node scripts/cursor-install-smoke.mjs .`
- **AC12 — subagent / Task spawn policy:** Without a fresh **session-matching**
  P5 marker, ordinary explore/shell types are allowed; with a fresh matching
  marker, shipped prosecutor agent names are allowed **and** an **unrelated**
  type/name is `ask`/`deny` on both `subagentStart` (defense-in-depth) and
  the authoritative `preToolUse` Task/spawn path. A marker for session A must
  not restrict session B. A hook that always allows fails this AC. Live proof
  requires a unique filesystem **canary** written only by the rejected Task
  agent: canary absent under deny; canary appears under allow/enforcement-off
  control. Nested-Task canary is required only after a lineage channel is pinned;
  until then ADR records degraded/permissive nested behavior and agents-backed
  stays blocked. Cursor version/platform recorded; if `subagentStart` deny is not
  honored, `preToolUse` remains the control and ADR notes the degradation.
  Verify: `node --test plugins/adlc-cursor/test/subagent.test.mjs` and
  deny-proof/runbook asserts for canary + preToolUse Task allowlist + version.
- **AC13 — live deny-proof:** Deny-proof runbook exists and is linked from
  `docs/integrations/cursor.md` Gaps; ADR-0006 has dated pass/fail + Cursor
  version; matrix cell updated when the matrix file exists; `failClosed`
  remains false on preToolUse. Runbook ordering (binding): assert unique sentinel **absent** on a pristine
  baseline; enforcement-on attempt; prove hash unchanged and sentinel still
  absent; **then** enforcement-off control proves the same edit mutates.
  Tool-reported deny alone is insufficient.
  Verify: docs path asserts in smoke + `node scripts/cursor-install-smoke.mjs .`
  hooks.json `failClosed: false` assert; runbook string asserts for sentinel /
  hash / enforcement-off control.
- **AC14 — /adlc-init one-flow:** `/adlc-init` documents CLI detect →
  `adlc init --harness cursor` → CI template without requiring
  `npx @adlc/cursor` for normal users.
  Verify: `node scripts/cursor-install-smoke.mjs .` and
  `node --test apps/docs/test/integration-facts.test.mjs`
- **AC15 — marketplace checklist honesty:** Publish checklist exists; docs do
  not fabricate a live cursor.com marketplace URL before submission succeeds.
  Verify: docs review checklist path present in
  `docs/integrations/cursor.md` (smoke string assert).
- **AC16 — scaffolder retained:** `@adlc/cursor` package `bin`
  (`adlc-cursor-scaffold`) remains.
  Verify: `node --test plugins/adlc-cursor/test/packaging.test.mjs`

- **AC17 — always-apply ticket fallback:** A dedicated plugin rule (e.g.
  `rules/adlc-ticket-context.mdc`) has `alwaysApply: true` and requires
  **canonical** active-ticket resolution (same error/ambiguity/unresolved
  outcomes as sessionStart — not raw pointer/env alone), using the AC19
  versioned session-resolution record when `workspace_roots` are unavailable
  (e.g. after dropped `additional_context`). Scaffold install/upgrade writes
  it for fresh and stock-hash matches; preserves sentinel-bearing user-modified
  rules (proposal/backup instead); docs/ADR state `sessionStart`
  `additional_context` is best-effort only. Tests cover conflict, stale hash,
  missing ticket, malformed pointer, multi-active ambiguity, directory-only
  store, dual-store ambiguity, pending-transaction, and plugin-cwd reads of
  success/tombstone records.
  Verify: `node --test plugins/adlc-cursor/test/*.test.mjs` (frontmatter +
  scaffold upgrade + semantic fixtures) and `node scripts/cursor-install-smoke.mjs .`
- **AC18 — preToolUse / Task payload fixtures:** Checked-in fixtures exercise
  docs-pinned `preToolUse` fields (`tool_name`, `tool_input`,
  `workspace_roots`, `tool_use_id`) **and** Task/spawn + `subagentStart`
  agent-name fields through the real extractor/dispatcher (allowed + unrelated);
  ADR-0006 no longer lists those fields as unverified once pinned.
  Verify: `node --test plugins/adlc-cursor/test/*.test.mjs` and ADR smoke
  asserts.

- **AC19 — versioned session-resolution record (T64):** sessionStart upserts a
  versioned record in `~/.adlc/cursor-session-workspaces.json` (or
  `ADLC_CURSOR_SESSION_INDEX`) keyed by SHA-256 session id, via **whole-index
  lock/CAS with fencing**. Schema (binding):
  `{ v, sessionId, outcome, root?, candidates?, errorClass?, generation, ts }`
  where `outcome` is `active` | `inactive` | `ambiguous` | `error` |
  `unresolved`. Failed/ambiguous/unresolved MUST write a TTL-bound tombstone
  record (not silent delete) so AC17 fallback can reconstruct the outcome from
  plugin cwd without `workspace_roots`. Success writes `root` + candidates.
  Concurrent distinct-session upserts must not drop entries; tombstones must
  not be resurrected by stale writers; TTL cleanup vs upsert and paused stale
  writers tested. Tests: real rule/helper from plugin cwd for success,
  ambiguity, corruption, and zero-root/unresolved.
  Verify: `node --test plugins/adlc-cursor/test/*.test.mjs`

## Out of scope (entire wave)

- VS Code Extension UI / status-bar webview.
- Treating in-session deny as a security boundary.
- Shell write enforcement beyond advisory.
- Expanding `mcp-server` gate allowlist.
- Breaking removal of the npm scaffolder.
- Changing CI rails-guard security semantics (document private-repo fallback
  only).
- Inventing hook events not in Cursor’s documented set.
- Tab-only hooks (`beforeTabFileRead` / `afterTabFileEdit`) unless a later
  ticket owns them.

## Verification commands (wave)

```sh
node scripts/cursor-install-smoke.mjs .
node --test plugins/adlc-cursor/test/*.test.mjs
adlc rails-guard --base main --ticket <active>
# T68: follow scripts/cursor-deny-proof runbook against a real Cursor binary
```

## References

- Issue https://github.com/voodootikigod/adlc/issues/241
- ADR `docs/adr/0006-adlc-cursor-integration.md`
- Spec `.adlc/specs/cursor-marketplace-plugin.md` (T47)
- Cursor plugins reference: https://cursor.com/docs/reference/plugins
- Cursor hooks: https://cursor.com/docs/agent/hooks
- Sibling MCP: `plugins/adlc-claude-code/.mcp.json`,
  `plugins/adlc-codex/.mcp.json`
- Sibling agents: `plugins/adlc-claude-code/agents/`
