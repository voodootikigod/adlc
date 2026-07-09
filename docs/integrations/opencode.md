# Adopt the ADLC in OpenCode

The `@adlc/*` toolkit is a set of gate-shaped CLIs. This plugin brings the
**Agentic Development Lifecycle** into the [OpenCode](https://opencode.ai)
terminal agent: an in-session rail-guard hook plus the `adlc` phase-routing
discovery skill.

> Design and rationale: [OpenCode integration plan](../opencode-integration-plan.md)
> (the authoritative contract) and [ADR 0004](../adr/0004-adlc-opencode-integration.md).
> Adoption guide: [`../opencode.md`](../opencode.md). The full thesis: [`../../ADLC.md`](../../ADLC.md).

## Status

Shipping so far: the rails-guard plugin (`plugins/adlc-opencode/`, plan Phase D —
**enforcing by default** since the 2026-07-05 amendment, see ADR 0004), the
discovery skill (deployed as a native Agent Skill,
`.opencode/skills/adlc/SKILL.md`), the **Phase A command surface** — `/adlc-init`,
`/adlc-ticket`, `/adlc-spec`, `/adlc-approve-spec`, `/adlc-decompose` plus the
gate-bin dependency mapping and deterministic `/adlc-init` scaffolding — the
**Phase C advisory session hooks** (`session.created` preflight, `session.idle`
gate-manifest audit — both surfaced as TUI toasts), and the **Phase E prosecution
surface** — the G4 build gate (`/adlc-verify-build`), the five P5 prosecution
subagents (`@prosecutor-correctness|security|contract|diff|tests`) plus the
`@prosecutor-verifier`, the `/adlc-prosecute` fan-out/verify/loop-until-dry
command, and `/adlc-distill` (P7). Phase F's CI backstop merged earlier.

**Native `adlc_gate` tool + live keyless bridge (Phase 4).** The model calls a
first-class `adlc_gate({ gate, args })` tool (registered via the plugin `tool`
hook) instead of being prose-instructed to shell out. `execute()` validates the
gate and runs it: deterministic gates run the `adlc` CLI; **LLM-backed gates run
KEYLESS through the host model** — `lib/keyless-bridge.mjs` `makeAsk` spins up an
isolated child session (`client.session.create` + `session.prompt`, source-
verified v1.17.13), answers each `--prompt-only` prompt, and threads the results
back. The keyless bridge is therefore **live code with a real caller now**, not
the tested-but-unwired library it used to be. Both are proven end-to-end against
a real opencode 1.17.13 by `scripts/opencode-live-tool.mjs` (CI-required). The
`lib/prosecutor.mjs` P5 decision helpers remain wired only to the model-driven
`/adlc-prosecute` flow; the deterministic first-party P5 runner that consumes
them is deferred to a Phase 4b follow-on.

> **Session hooks — event-name note.** The plan specified `session.created` +
> `session.ended`, but OpenCode has no `session.ended`; the end-of-work signal is
> `session.idle`, which the gate-manifest audit uses. Both hooks are advisory:
> they only surface warnings, never throw, and no-op when the repo is not
> ADLC-initialized.

> **Keyless bridge — LIVE (Phase 4).** `makeAsk` now spins up an isolated child
> session via the real SDK (`client.session.create` + `session.prompt`) and
> returns the reply text; there is **no server-side structured-output mode**, so
> the answer is the concatenated text of the reply's text parts (the gate prompts
> specify their own output shape). It returns `null` only when the client lacks
> the session API, so the caller falls back to the CLI rather than silently
> skipping a gate. Proven end-to-end by `scripts/opencode-live-tool.mjs`.

## Commands

OpenCode loads project commands from `.opencode/commands/` (Markdown + YAML
frontmatter). `/adlc-init` deploys this plugin's `command/*.md`, `agent/*.md`, and
`skill/*.md` into `.opencode/`, creates `.adlc/config.json`, **and registers the
plugin in `.opencode/opencode.json` so the rails-guard hook actually loads** — all
idempotently, via `lib/scaffold.mjs`. (Commands/agents/skills are inert markdown;
the enforcing hook only runs once the plugin package is registered.) Phase A commands:

| Command | Phase | Does |
| --- | --- | --- |
| `/adlc-init` | — | Bootstrap `.adlc/`, scaffold `.opencode/`, preflight |
| `/adlc-ticket` | P0 | Author + triage a ticket (lock-safe write, coldstart check) |
| `/adlc-spec` | P1 | Interrogate the spec (`parallax`, `spec-lint`, `premortem`, prompt-only) |
| `/adlc-approve-spec` | P1 G1 | Record the human spec approval |
| `/adlc-decompose` | P2 | Slice into tickets, `coldstart` + `merge-forecast` |

> **Trust-boundary tickets (enforcement, auth, secrets, data-loss, CI/CD): also run
> an adversarial *design* review at the P1→P2 boundary** — a recommended practice
> ([ADR 0005](../adr/0005-adversarial-design-review-gate.md)). The other P1 gates
> check that a ticket is clear and executable; the design review asks the question
> they don't — *can this control be bypassed, and who controls it?* Run
> `adversarial-review` in planning mode, apply the stopping rule, and record the
> verdict in the ticket / feature ADR threat model.

## Install

Two commands (peer dependency: `@opencode-ai/plugin` >= 1.17.13 — the version
whose documented hook contract the enforce-by-default posture is pinned against):

```sh
# 1. The gate toolkit — the plugin shells out to the `adlc` binary
npm install -g @adlc/cli

# 2. Bootstrap the project — scaffolds .adlc/ + .opencode/, registers the plugin
npx @adlc/opencode-package init
```

Then **restart OpenCode** so it loads the plugin — the `tool.execute.before`
rails-guard hook and the `session.created` / `session.idle` advisory hooks become
active, and `/adlc-ticket`, `/adlc-spec`, `/adlc-prosecute`, etc. are available.
Inside the TUI, `/adlc-init` re-runs the same idempotent scaffold (refreshes
commands/agents/skills from the package and runs preflight).

The bootstrap registers the package in `.opencode/opencode.json`'s `plugin`
array — opencode auto-installs npm plugin entries via Bun on launch. Running the
bootstrap from a **source checkout** instead registers the resolved local path
(the npm name is only registered when the package actually runs out of
`node_modules`, so the entry is always resolvable). If the Claude Code ADLC
integration is already installed, skills that exist under `.claude/skills/` are
not deployed a second time — opencode discovers Claude-compatible skills there
natively.

### Per-repo configuration (plugin-options tuple)

Options ride the `[name, options]` tuple form of the `plugin` entry; explicitly
set env vars override them (an env var is a per-invocation operator decision,
the tuple is the repo default). The audited bypasses (`ADLC_RAILS_BYPASS`,
`ADLC_BUILD_GATE_BYPASS`) are deliberately NOT available as options.

```jsonc
// .opencode/opencode.json
{
  "plugin": [["@adlc/opencode-package", {
    "advisoryHooks": false,          // true = downgrade rails guard to advisory (env: ADLC_ALLOW_ADVISORY_HOOKS=1)
    "ungatedTools": [],              // extra benign no-target tools, still spoof-guarded (env: ADLC_UNGATED_TOOLS)
    "suppressionEnforcement": false, // enforce (not warn) suppression markers (env: ADLC_SUPPRESSION_ENFORCEMENT=1)
    "scopeEnforcement": false        // enforce (not warn) out-of-scope edits (env: ADLC_SCOPE_ENFORCEMENT=1)
  }]]
}
```

Local verification (no `opencode` binary needed, does not mutate your environment):

```sh
node scripts/opencode-install-smoke.mjs .
```

That smoke test validates the plugin manifest, the `tool.execute.before` hook
wiring, command/agent/skill registration, the scaffolder, the `@adlc/core`
delegation (the rail engine is not re-implemented), and runs the plugin unit tests.
An end-to-end deny proof against a live `opencode` binary is the remaining GA
verification — see [ADR 0004](../adr/0004-adlc-opencode-integration.md).

## Rail enforcement — two layers

The integration enforces frozen rails at two layers:

1. **In-session hook (enforcing by default).** The plugin's `tool.execute.before`
   hook denies structured mutations to a frozen rail declared by the active
   ticket: a thrown error in the hook **aborts the tool call** — documented host
   behavior on `@opencode-ai/plugin` >= 1.17.13, regression-tested end-to-end by
   `scripts/opencode-live-deny.mjs`. Every extractable target path is checked
   (`filePath`, `files[]`, `edits[]`); a mutating or *unknown* tool whose target
   cannot be extracted is denied while rails are in force (fail closed — a
   deliberate tradeoff: an unrecognized third-party write tool must not slip
   past on arg shape; a benign no-target tool a railed build needs can be
   explicitly opted out via `ADLC_UNGATED_TOOLS="tool_a,tool_b"`, which still
   gets the frozen-rail-target spoof guard). Denials and advisory warnings
   surface as TUI toasts (`client.tui.showToast`) with stderr as fallback. The
   only enforcement downgrade is the explicit escape hatch
   `ADLC_ALLOW_ADVISORY_HOOKS=1` (surface, don't block). The hook no-ops unless
   the repo is ADLC-initialized and `ADLC_P4_ENFORCEMENT=1`. It remains
   inherently bypassable by a hostile agent (which controls its own environment
   and the active-ticket selector), so it is still **not** the real control.
2. **Commit-time CI gate (mandatory, unbypassable).** The real control is
   [`../ci/rails-guard.yml`](../ci/rails-guard.yml) driving `scripts/rails-guard-ci.mjs`
   — a harness-agnostic diff gate that reads the frozen rail set from the trusted
   base ref and rejects a PR that touches it. Make it a required check. Because it
   inspects the git diff, it already covers OpenCode-authored changes and the
   shell-driven writes the in-session hook cannot see.

   **Private-repo / free-plan caveat:** on a private repo on GitHub's free plan,
   both required-status-check mechanisms (branch-protection `PUT`, rulesets
   `POST`) return 403, so this gate can never actually be made a required check
   there. Fold the rail-freeze step into your existing required job instead —
   see the "Private-repo fallback" sketch at the bottom of
   [`../ci/rails-guard.yml`](../ci/rails-guard.yml).

## Rail contract

Mirrors the sibling integrations (`adlc-codex`, `adlc-pi`), delegating all
glob/ticket logic to `@adlc/core`:

- Active ticket resolved from `ADLC_TICKET` or `.adlc/current-ticket.json`
  (conflict → fail closed).
- Rails in force = the **single active ticket's** `rails` plus the implicit
  trust-root rails `.adlc/tickets.json` and `.adlc/current-ticket.json` (frozen so
  the rail set can't be quietly edited away).
- No-op when the repo isn't ADLC-initialized, enforcement is off, no active ticket
  is resolved, or the path isn't a frozen rail.

## Formal ADLC Coverage

| Phase | Status | Wired via |
| --- | --- | --- |
| P0 Triage | **Yes** | `/adlc-ticket` (Phase A) |
| P1 Interrogate | **Yes** | `/adlc-spec` + `/adlc-approve-spec` (Phase A) + the `adlc` skill |
| P2 Decompose | **Yes** | `/adlc-decompose` (Phase A) |
| P3 Rail | **Yes** | the in-session rails-guard hook (enforcing by default, live-deny-proofed) + CI gate |
| P4 Build | **Yes** | rails-guard hook (structured + shell) + build-gate context-rot backstop + `file.edited` watcher (suppression/scope/rails) + per-turn context injection + tool.definition rail notice + flail advisory + advisory preflight |
| P5 Prosecute | **Yes** | `/adlc-verify-build` (G4) + 5 prosecutor lenses + verifier + `/adlc-prosecute` |
| P6 Integrate | Partial | `session.idle` advisory gate-manifest audit; the human gate is by design |
| P7 Distill | **Yes** | `/adlc-distill` (Phase E) |

## Gaps

1. **P5 orchestration is still model-driven.** `/adlc-prosecute` describes the
   fan-out → dedupe → verify → loop-until-dry protocol (the decision helpers in
   `lib/prosecutor.mjs` are unit-tested), but the loop itself is executed by the
   model invoking the subagents, not a deterministic first-party runner. The
   keyless bridge that would let a native `adlc_prosecute` tool spawn lens/verifier
   child sessions is now proven (Phase 4); wiring the deterministic runner on top
   is the **Phase 4b** follow-on.
2. **`permission.ask` is a DORMANT lever.** At opencode 1.17.13 the hook is
   defined but never dispatched (upstream sst/opencode#7006); the plugin ships a
   tolerant handler (denies rail-target permissions under both documented payload
   shapes) that activates the moment upstream wires it. The enforcing control is
   the `tool.execute.before` throw.
3. **Floating leading-`**` rails and in-session directory deletion.** The
   in-session shell guard denies deleting/moving a rail's *fixed-anchor* parent
   (`rm -rf test` vs `test/**`, `rm -rf packages/foo/test` vs
   `packages/*/test/**`, `rm -rf .`). A rail with a *leading* `**` (e.g.
   `**/*.test.mjs`) has no fixed root, so it can't flag an arbitrary parent
   directory in-session without denying every unrelated edit; a directory
   deletion under such a rail is caught by the CI diff gate (authoritative) and,
   for the per-file events it emits, the `file.edited` backstop. Direct writes to
   a matching file are always denied in-session.

Resolved 2026-07-05 (Phase 1): in-session enforcement no longer depends on an
unproven SDK capability — a thrown denial is documented host behavior and the
live deny proof (`scripts/opencode-live-deny.mjs`, required CI) regression-tests
it. See ADR 0004's amendment.

Resolved 2026-07-08 (Phase 3): **native-feel surface added (server-side).** Per-turn
the active ticket, frozen rails, and scope are re-stated to the model via
`experimental.chat.system.transform` (context-rot defense), and the frozen rails
are named in the `edit`/`write`/`apply_patch` tool descriptions via
`tool.definition` — so the model is reminded *before* it acts. Ticket fields are
sanitized (control chars stripped, length-capped) before injection so a ticket
can't smuggle prompt directives. A `tool.execute.after` **flail advisory** warns
once per file edited ≥3× in a session (reuses `@adlc/flail-detector`; per-session
state is LRU-bounded and evicted on `session.idle`). The active-ticket
**statusline** (`ADLC <ticket> · P4 enforcing · N rails frozen`) is surfaced at
`session.created` via the confirmed `client.tui.showToast` channel.

> **Deferred: the native TUI plugin module.** A full `tui`-export module
> (persistent JSX statusline slot, `DialogConfirm` for the P1→G1 gate, native OS
> notifications) is possible — the `tui` surface shipped in opencode **1.17.0** —
> but it is **deliberately not in this integration yet.** It can only be authored
> in Solid JSX with a build step and can only be verified inside a live opencode
> ≥ 1.17 TUI; this repo's plugin is plain `.mjs` with no build, and the test
> harness runs a headless 1.16.2 binary, so that module could only be shipped as
> unverifiable, guessed-API code — which this integration does not do. It is
> tracked as a follow-on for an environment that can build and live-verify it.
> The verifiable native touch (the statusline toast) ships now.

Resolved 2026-07-08 (Phase 2): **bash is now gated in-session** via the
codex-parity shell classifier (`@adlc/core` `classifyShellCommand`: read-only
allow, opaque/expanding/cwd-changing/pathless mutations deny, literal targets
checked against rails); a **build-gate context-rot backstop** (imports
`@adlc/build-gate`) denies structured mutations on high-risk tickets once the
session is degraded (tool-call depth > threshold, or a `session.compacted`
event), with the audited `ADLC_BUILD_GATE_BYPASS=1` override; and the
**tool-name-independent `file.edited` backstop** quarantines-then-restores any
write that lands on a frozen rail regardless of which tool wrote it (path
normalized against traversal, loop-guarded, arg-array git, nothing silently
destroyed — a frozen rail must equal HEAD, so restoring it is correct by
definition). Suppression-marker and scope checks ride the same watcher but are
**advisory only** (they warn and never `git checkout`, so an auto-revert can't
discard unrelated in-progress work). `apply_patch` envelopes are parsed for
in-band targets so GPT-5-class models (where apply_patch is the ONLY mutator)
stay path-transparent. The shell classifier segment-splits chained commands so a
read-only prefix can't shadow a later mutator.

## Boundary

- `.adlc/` is the runtime state area for tickets, manifests, and gate evidence.
- The plugin delegates every rail/glob/ticket primitive to `@adlc/core`; it adds
  only the OpenCode-specific hook wiring and the enforcement-capability gate.
- Package READMEs remain the source of truth for exact flags, schemas, and exit codes.
