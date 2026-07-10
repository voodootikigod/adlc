# ADR: OpenCode integration — rails-guard plugin MVP

**Status:** **Accepted — MVP shipped (P3 rail guard); Phases A/B/C/E follow-on.
Amended 2026-07-05: enforcement contract verified against `@opencode-ai/plugin`
v1.17.13 — the hook now ENFORCES BY DEFAULT (see Amendment).**
The detailed design is the [OpenCode integration plan](../integrations/../opencode-integration-plan.md);
this ADR records the decisions for the first shippable increment (ticket T1) and
the verified facts the build rests on.

**Date:** 2026-06-27
**Deciders:** Chris Williams (with an independent adversarial-review counter-model).

> Companion to [ADR 0003](./0003-adlc-claude-code-plugin.md) (Claude Code) and
> [ADR 0001](./0001-codex-native-adlc-integration.md) (Codex). The risk-gated
> pre-build review that shaped this ticket is [ADR 0005](./0005-adversarial-design-review-gate.md).

## Context

The OpenCode integration was designed in full (`docs/opencode-integration-plan.md`,
6 phases A–F) and its Phase F CI backstop shipped in #15. What remained unbuilt was
the actual plugin. This ADR covers the **MVP**: the in-session rails-guard hook
(plan Phase D) plus the discovery skill — the smallest increment that makes rail
enforcement real in OpenCode.

## Decision

Ship `plugins/adlc-opencode/` as a small ESM plugin that wires OpenCode's
`tool.execute.before` hook to a rail-enforcement decision, **delegating every
rail/glob/ticket primitive to `@adlc/core`** (no re-implementation — this avoids
the duplicated-legacy-hook tech debt the plan flags in §6.6).

### Resolved OpenCode plugin API (pinned)

```
package:           @opencode-ai/plugin   (peerDependency >=1.17.11)
edit-interception: tool.execute.before   async (input, output) => { ... }
mutating tools:    input.tool === "edit" | "write"   (Bash writes fall to the CI gate)
edited path:       input.args.filePath   (handler also falls back to output.args.filePath)
deny mechanism:    throw new Error(reason)   — IFF the host SDK honors it (see capability gate)
plugin shape:      export const adlcRailsGuard: Plugin = async ({ directory, worktree, project }) => ({ ... })
load path:         .opencode/plugin/adlc-opencode/  or the "plugin" array in opencode.json
```

### Enforcement-capability gate (resolves the "does throw abort the write?" question)

Per the plan's Phase D, the in-session hook is **not treated as enforcing** unless
the host SDK is confirmed to honor a thrown denial (`onFailure: deny`). A runtime
probe (`probeEnforcementCapability`) gates this; absent the capability the hook is
**advisory** and fails closed unless `ADLC_ALLOW_ADVISORY_HOOKS=1`. The unbypassable
control is always the commit-time CI gate (`docs/ci/rails-guard.yml`).

### Rail contract (delegated, sibling-faithful)

Active ticket via `ADLC_TICKET` or `.adlc/current-ticket.json` (conflict → fail
closed); enforcement phase-gated on `ADLC_P4_ENFORCEMENT=1`; rails = the single
active ticket's `rails` plus the trust-root rails `.adlc/tickets.json` and
`.adlc/current-ticket.json`; no-op when uninitialized / off / no active ticket.

## Threat Model

The in-session hook is **bypassable by design** and must not be mistaken for the
control:

- The agent controls its own environment, so it can leave `ADLC_P4_ENFORCEMENT`
  unset, point `ADLC_TICKET` / `.adlc/current-ticket.json` at a rail-free ticket,
  or (if the SDK lacks `onFailure: deny`) ignore an advisory denial.
- Bash-driven writes are not gated in-session (Turing-complete shell).
- Unrecognized mutation tools: the gate fails **closed** on tool names — only
  known read-only tools (`read`/`grep`/`glob`/…) are skipped; known mutators
  (`edit`/`write`/`patch`/`multiedit`/`apply_patch`) and any unrecognized
  structured tool carrying a file path are checked, so a new tool name can't slip
  an edit past the guard.
- Symlink aliasing: an edit to a symlink whose real target is a frozen rail. The
  checker resolves symlinks (target + existing parent segments) before rail
  comparison (`resolveRailPath`), so an aliased write to a rail is denied — a
  hardening the legacy sibling hooks do not yet have and should adopt via
  `@adlc/core` (integration-plan §6.6).

Mitigation: the unbypassable commit-time CI gate (`docs/ci/rails-guard.yml`) reads
the frozen rail set from the trusted base ref and rejects offending PRs regardless
of how the edit was made. It protects the trust roots (including `.adlc/admin.pub`,
added in #15) so the rail set and recovery key can't be quietly rewritten.

## Unverified / follow-on

- ~~**`input.args.filePath` vs `output.args.filePath`**~~ — **RESOLVED (2026-07-05):**
  verified against `@opencode-ai/plugin` v1.17.13 source: the mutable args live on
  `output.args`; `input` carries only `{ tool, sessionID, callID }`. The handler
  reads `output.args` first (with an `input.args` tolerance fallback for older hosts).
- ~~**Live deny proof (AC7)**~~ — **RESOLVED (2026-07-05):**
  `scripts/opencode-live-deny.mjs` drives a real `opencode` binary with a mock
  OpenAI-compatible provider: a control run proves the write executes when
  enforcement is off; the treatment run proves the write is aborted and the deny
  reason reaches the model. Wired into the required CI `test` job (private-repo
  fallback per `docs/ci/rails-guard.yml`).
- **TS + bundled `dist/index.js`** — the MVP ships plain `.mjs` (no build step);
  the plan's bundled-distribution form is a follow-on.
- **Phases A/B/C/E** — command suite, keyless bridge, advisory hooks, prosecutor
  lenses (follow-on tickets T2–T5).

## Amendment — 2026-07-05: enforce by default (opencode-native-flush Phase 1)

The July-2026 verification of OpenCode's extension surface
(`@opencode-ai/plugin` v1.17.13, opencode.ai/docs `plugins.mdx`) answered the
open questions this ADR had left gated:

1. **A thrown error in `tool.execute.before` ABORTS the tool call** — documented
   host behavior, no longer an assumption. The capability probe
   (`probeEnforcementCapability`) and its `ADLC_OPENCODE_ENFORCES` flag are
   therefore **retired**; the hook enforces by default. The only downgrade is the
   explicit operator escape hatch `ADLC_ALLOW_ADVISORY_HOOKS=1` (surface, don't
   block). The retired probe was also structurally unreachable — the plugin never
   captured the SDK `client` object — which the amendment fixes: `client` is now
   threaded into the hooks.
2. **Deny visibility**: denials and advisory warnings now surface via
   `client.tui.showToast` and `client.app.log` (stderr retained as fallback), so
   the advisory layer is visible in the TUI, not only in a log nobody watches.
3. **Fail closed on unextractable targets**: `patch`/`multiedit`/`apply_patch`
   (and any unknown tool) whose target path cannot be extracted from its args are
   DENIED while rails are in force, instead of silently allowed — closing the
   arg-shape bypass. Multi-file shapes (`files[]`, `edits[]`) are extracted and
   each target checked; tool names are normalized before classification.
4. **Canonical plural layout**: the scaffolder deploys native Agent Skills
   (`.opencode/skills/<name>/SKILL.md`) and migrates the legacy flat
   `.opencode/skill/*.md` deployment.

The pinned API block above is superseded accordingly: peerDependency
`>=1.17.13`, edited path on `output.args`, deny mechanism `throw` (documented,
regression-tested by the live deny proof).

## Amendment — 2026-07-09: upstream sync (T31)

Dated re-verification against the current upstream, which had moved and advanced
since the Phase-1 amendment:

1. **Repo moved to `anomalyco/opencode`** (from the former sst org path). The
   org rebranded; opencode.ai docs remain canonical and npm still publishes
   `@opencode-ai/*` from the same tags. All in-repo references were swept to the
   new path (issue links included); the install smoke gates that stale live
   references stay at zero.
2. **`permission.ask` is still DORMANT — DISPATCHED = NO.** Re-verified FROM
   SOURCE at tags **v1.17.17 and v1.17.18** (newest at the time): the string
   `permission.ask` occurs only in the Hooks type
   (`packages/plugin/src/index.ts`); it is never passed to `plugin.trigger()`,
   and the real permission path (`packages/opencode/src/permission/index.ts`)
   publishes the `permission.asked` event without invoking any plugin hook.
   Upstream **anomalyco/opencode#7006 remains OPEN**. Nothing between 1.17.13 and
   1.17.18 wired it. Decision: keep the tolerant handler (it activates the instant
   upstream dispatches the hook) but the **`tool.execute.before` throw remains the
   only load-bearing in-session gate**; `permission.ask` must not be counted as an
   enforcement lever.
3. **Falsified `session.prompt` assumption (Phase 4 correction).** The
   `opencode-native-flush` plan assumed `session.prompt({outputFormat})` for
   JSON-schema structured output. **No such field exists** (verified through
   1.17.17). The keyless bridge concatenates the reply's text parts; structured
   output is obtained via a registered verdict *tool* schema, not a prompt option.
4. **Version-matrix CI (drift armor).** The two live proofs
   (`opencode-live-deny.mjs`, `opencode-live-tool.mjs`) run required against the
   pinned floor `opencode-ai@1.17.13` AND advisory (`continue-on-error`) against
   `opencode-ai@latest` in the `opencode-live-latest` job — a breaking upstream
   change surfaces same-day without blocking unrelated merges. The peerDependency
   floor stays `>=1.17.13` (the contract-verified, required-proof version); bump
   it deliberately when the canary shows sustained green on a newer line.

## Amendment — 2026-07-10: native tools live (Phases 4 & 4b / T33)

1. **Keyless bridge is LIVE (Phase 4).** `makeAsk` spins an isolated child
   session (`client.session.create({parentID})` + `session.prompt`) and threads
   the reply back — no longer a "proposed SDK extension" or a tested-but-unwired
   library. The native **`adlc_gate`** tool (plugin `tool` hook) lets the model
   call gates directly; LLM-backed gates run keyless through the host model.
2. **`session.prompt` has NO `outputFormat`** (confirmed through 1.17.17). The
   flush plan's assumption of server-side JSON-schema structured output was
   FALSE. Structured output is obtained via a **registered verdict tool** (or
   fenced-JSON parsing, fail-closed) — not a prompt option.
3. **Deterministic P5 runner (Phase 4b / T33).** The native **`adlc_prosecute`**
   tool drives fan-out → dedupe → verify → loop-until-dry in first-party code
   (`lib/prosecute-runner.mjs`), not model-driven orchestration. Lens/verifier
   work runs in child sessions locked down by a **wildcard-deny-first read-only
   tools allowlist** (`{ "*": false, <read tools>: true }` — the shape opencode's
   own `explore`/`compaction` agents use): unlisted tools (`edit`/`write`,
   `task`, MCP, future) hard-deny, so a lens cannot mutate even via a sub-agent
   or an injection in the untrusted diff. A denylist would fail OPEN here (the
   SDK `tools` map is a sparse override; absent = base agent default = enabled) —
   this is a security-load-bearing decision, verified against opencode source.
4. **Install + parity (T30/T34).** `@adlc/opencode-package` is publishable
   (folded into the lockstep release) with an `npx @adlc/opencode-package init`
   bootstrap; the scaffolder registers a resolvable entry (npm name from
   node_modules, resolved path from source). `/adlc-maintain` + the `prosecutor`
   meta-agent (7th agent) port the CC maintenance surface; gate-fuzzing
   calibration is neither host- nor deterministic-cron-run (needs a separate
   model+sandbox job).

## Consequences

Rail enforcement is real in OpenCode for the common structured-edit path, with the
rail engine delegated to a single source of truth. In-session enforcement is now
default-on (documented host contract + live regression proof), with the CI gate
remaining the unbypassable backstop for shell-driven writes and hostile
environments. The advisory/CI two-layer framing survives for the explicitly
downgraded mode only.
