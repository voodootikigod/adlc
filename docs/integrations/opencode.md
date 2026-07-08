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

**Honesty note on Phase B and the P5 helpers:** `lib/keyless-bridge.mjs`
(extract a gate's prompts, ask, thread answers) and the `lib/prosecutor.mjs`
decision helpers are implemented and unit-tested but **not yet wired into a
runtime path** — today the commands instruct the model to run gates via
`adlc <gate> --prompt-only` and reason over the printed output itself. Wiring
them to the now-available SDK (`client.session.create` + `session.prompt`) is
the `opencode-native-flush` plan's Phase 4
([spec](../specs/opencode-native-flush.md)).

> **Session hooks — event-name note.** The plan specified `session.created` +
> `session.ended`, but OpenCode has no `session.ended`; the end-of-work signal is
> `session.idle`, which the gate-manifest audit uses. Both hooks are advisory:
> they only surface warnings, never throw, and no-op when the repo is not
> ADLC-initialized.

> **Keyless bridge — SDK dependency (plan §6.4).** The bridge's protocol (extract
> a gate's prompts, ask, thread answers) is implemented and tested, and the SDK
> capability it was waiting for now exists (`client.session.create` +
> `session.prompt` with structured output, verified on `@opencode-ai/plugin`
> v1.17.13). Wiring `makeAsk` to it is Phase 4 of the
> [`opencode-native-flush` plan](../specs/opencode-native-flush.md); until then
> `makeAsk` returns `null` so callers fail closed rather than silently skip a gate.

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

The plugin ships in this repo at `plugins/adlc-opencode/`. The
`@adlc/opencode-package` package is **not yet published to npm**, so install from
source for now (peer dependency: `@opencode-ai/plugin` >= 1.17.13 — the version
whose documented hook contract the enforce-by-default posture is pinned against).

**1. Install the gate toolkit** — the plugin shells out to the `adlc` binary:

```sh
npm install -g @adlc/cli
```

**2. Make the plugin available to OpenCode** — symlink the source into your
project's plugin directory, or register its path in `opencode.json`:

```sh
ln -s /path/to/adlc/plugins/adlc-opencode .opencode/plugin/adlc-opencode
# …or add "/path/to/adlc/plugins/adlc-opencode" to the "plugin" array in
#    .opencode/opencode.json (project) or ~/.config/opencode/opencode.json (global)
```

**3. Bootstrap the workspace** — in the OpenCode TUI:

```
/adlc-init
```

`/adlc-init` creates `.adlc/` (the committable ticket contract + `config.json`),
deploys the command/agent/skill surface into `.opencode/`, **registers the plugin
in `opencode.json` so the rails-guard hook loads**, and runs preflight. First-time,
before the `/adlc-init` command is available, run the scaffolder directly:

```sh
node /path/to/adlc/plugins/adlc-opencode/lib/scaffold-cli.mjs .
```

**4. Restart OpenCode** so it loads the plugin — the `tool.execute.before`
rails-guard hook and the `session.created` / `session.idle` advisory hooks become
active. `/adlc-ticket`, `/adlc-spec`, `/adlc-prosecute`, etc. are then available.

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

1. **Phase-E orchestration is model-driven.** `/adlc-prosecute` describes the
   fan-out → dedupe → verify → loop-until-dry protocol (the decision helpers in
   `lib/prosecutor.mjs` are unit-tested), but the loop itself is executed by the
   model invoking the subagents, not a deterministic first-party runner — the same
   gap the Codex path documents for P5. A native-tool deterministic runner is
   plan Phase 4.
2. **The keyless bridge is unwired** (see the honesty note under Status) — plan
   Phase 4.
3. **`permission.ask` is a DORMANT lever.** At opencode 1.17.13 the hook is
   defined but never dispatched (upstream sst/opencode#7006); the plugin ships a
   tolerant handler (denies rail-target permissions under both documented payload
   shapes) that activates the moment upstream wires it. The enforcing control is
   the `tool.execute.before` throw.
4. **Floating leading-`**` rails and in-session directory deletion.** The
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
