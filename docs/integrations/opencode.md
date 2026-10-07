# Adopt the ADLC in OpenCode

The `@adlc/*` toolkit is a set of gate-shaped CLIs. This plugin brings the
**Agentic Development Lifecycle** into the [OpenCode](https://opencode.ai)
terminal agent: an in-session rail-guard hook plus the `adlc` phase-routing
discovery skill.

> Design and rationale: [OpenCode integration plan](../opencode-integration-plan.md)
> (the authoritative contract) and [ADR 0004](../adr/0004-adlc-opencode-integration.md).
> The full thesis: [`../../ADLC.md`](../../ADLC.md).

## Status

Shipping so far: the rails-guard plugin (`plugins/adlc-opencode/`, plan Phase D —
**enforcing by default** since the 2026-07-05 amendment, see ADR 0004), the
discovery skill (deployed as a native Agent Skill,
`.opencode/skills/adlc/SKILL.md`), the **Phase A command surface** — `/adlc-init`,
`/adlc-ticket`, `/adlc-spec`, `/adlc-approve-spec`, `/adlc-decompose` plus the
gate-bin dependency mapping and deterministic `/adlc-init` scaffolding — the
**Phase C advisory session hooks** (`session.created` preflight, `session.idle`
gate-manifest audit — both written to stderr), and the **Phase E prosecution
surface** — the G4 build gate (`/adlc-verify-build`), the five P5 prosecution
subagents (`@prosecutor-correctness|security|contract|diff|tests`) plus the
`@prosecutor-verifier`, the `/adlc-prosecute` fan-out/verify/loop-until-dry
command, and `/adlc-distill` (P7). Phase F's CI backstop merged earlier.

**Native `adlc_gate` tool + live keyless bridge (Phase 4).** The model calls a
first-class `adlc_gate({ gate, args })` tool (added as a direct, non-Code-Mode
tool through `ctx.tool.transform`) instead of being prose-instructed to shell
out. `execute()` validates the gate and runs it: deterministic gates run the
`adlc` CLI; **LLM-backed gates run KEYLESS through the host model** —
`lib/keyless-bridge.mjs` `makeAsk` answers each `--prompt-only` prompt with the
stateless `ctx.generate.text` and threads the results back. Both are proven
end-to-end against a real OpenCode 2.0.20 by `scripts/opencode-live-tool.mjs`
(CI-required). The
`lib/prosecutor.mjs` P5 decision helpers now drive the deterministic first-party
P5 runner (`adlc_prosecute`, T33 / Phase 4b — see the "Resolved 2026-07-09"
note below); `/adlc-prosecute` calls that tool first and keeps the model-driven
prose protocol as the fallback.

> **Session hooks — event-name note.** The plan specified `session.created` +
> `session.ended`, but OpenCode has no `session.ended`; the end-of-work signal is
> `session.idle`, which the gate-manifest audit uses. Both hooks are advisory:
> they only surface warnings, never throw, and no-op when the repo is not
> ADLC-initialized.

> **Keyless bridge — LIVE (Phase 4).** `makeAsk` sends each gate prompt to
> `ctx.generate.text` (a stateless generation with no tools) and returns the
> trimmed reply text; there is **no server-side structured-output mode** (the
> gate prompts specify their own output shape). It returns `null` only when the
> host exposes no `generate.text`, so the caller falls back to the CLI rather
> than silently skipping a gate. Proven end-to-end by
> `scripts/opencode-live-tool.mjs`.

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

See [Version requirements](../toolkit.md#version-requirements) for the shared
`@adlc/cli`/plugin lockstep-versioning requirement.

Requires **OpenCode >= 2.0.20** (the v2 plugin API; optional peer dependency
`@opencode/plugin` `>=2.0.20 <3`). OpenCode 1.x cannot load this plugin — see
[OpenCode 2](#opencode-2-v2-plugin-api) below. Two commands:

```sh
# 1. The gate toolkit — the plugin shells out to the `adlc` binary
npm install -g @adlc/cli

# 2. Bootstrap the project — scaffolds .adlc/ + .opencode/, registers the plugin
npx @adlc/opencode init
```

Then **restart OpenCode** so it loads the plugin — the `execute.before`
rails-guard hook and the `session.created` / `session.idle` advisory event
handlers become active, and `/adlc-ticket`, `/adlc-spec`, `/adlc-prosecute`, etc. are available.
Inside the TUI, `/adlc-init` re-runs the same idempotent scaffold (refreshes
commands/agents/skills from the package and runs preflight).

The bootstrap registers the package in `.opencode/opencode.json`'s v2 `"plugins"`
array — OpenCode installs package entries from npm on launch. An existing v1
`"plugin"` entry for this package is migrated into `"plugins"` (its options
kept; other plugins' v1 entries are left alone). Running the bootstrap from a
**source checkout** instead registers the resolved local package directory
(the npm name is only registered when the package actually runs out of
`node_modules`, so the entry is always resolvable). If the Claude Code ADLC
integration is already installed, skills that exist under `.claude/skills/` are
not deployed a second time — opencode discovers Claude-compatible skills there
natively.

### Per-repo configuration (plugin options)

Options ride the `{ "package", "options" }` object form of the `plugins` entry
(the plugin reads them from `ctx.options`); explicitly set env vars override
them (an env var is a per-invocation operator decision, the options are the
repo default). The audited bypasses (`ADLC_RAILS_BYPASS`,
`ADLC_BUILD_GATE_BYPASS`) are deliberately NOT available as options.

```jsonc
// .opencode/opencode.json
{
  "plugins": [{
    "package": "@adlc/opencode",
    "options": {
      "advisoryHooks": false,          // true = downgrade rails guard to advisory (env: ADLC_ALLOW_ADVISORY_HOOKS=1)
      "ungatedTools": [],              // extra benign no-target tools, still spoof-guarded (env: ADLC_UNGATED_TOOLS)
      "suppressionEnforcement": false, // enforce (not warn) suppression markers (env: ADLC_SUPPRESSION_ENFORCEMENT=1)
      "scopeEnforcement": false        // enforce (not warn) out-of-scope edits (env: ADLC_SCOPE_ENFORCEMENT=1)
    }
  }]
}
```

Local verification (no `opencode` binary needed, does not mutate your environment):

```sh
npm test --workspace=@adlc/opencode
```

That command drives the v2 `setup(ctx)` entry against a recording fake
context — hook, transform and event-subscription wiring, command/agent/skill
registration, the scaffolder, the `@adlc/core` delegation (the rail engine is
not re-implemented) — and runs the plugin unit tests. The end-to-end proofs
against a live OpenCode 2 binary are `scripts/opencode-live-deny.mjs` and
`scripts/opencode-live-tool.mjs` (both CI-required).

## OpenCode 2 (v2 plugin API)

The plugin targets the **OpenCode v2 plugin API only** and requires
**OpenCode >= 2.0.20**. Its default export is a v2 definition,
`{ id: "adlc", setup(ctx) }`; `setup` registers every hook, transform and event
subscription through `ctx` and returns a cleanup function. OpenCode 1.x cannot
load it (a v1 host rejects the entry), and there is no dual v1/v2 export — stay
on an earlier `@adlc/opencode` release if you are still on OpenCode 1.x.

Register it under the v2 `"plugins"` key (the bootstrap does this, and migrates
an existing v1 `"plugin"` entry for this package):

```jsonc
// .opencode/opencode.json
{
  "plugins": [
    { "package": "@adlc/opencode", "options": { "advisoryHooks": false } }
  ]
}
```

How each v1 hook maps onto v2:

| v1 hook | v2 registration |
| --- | --- |
| `tool.execute.before` / `.after` | `ctx.tool.hook('execute.before' / 'execute.after')` |
| `permission.ask` | `ctx.permission.hook('evaluate')` |
| `experimental.chat.system.transform` | `ctx.session.hook('context')` (pushes a system part) |
| `experimental.session.compacting` | `ctx.session.hook('compaction')` |
| `command.execute.before` | `ctx.session.hook('prompt')` on prompts starting `/adlc-` |
| `tool.definition` + `tool` map | `ctx.tool.transform` (rail notice; `adlc_gate`, `adlc_prosecute` as direct tools) |
| `event` (`file.edited`, `session.compacted`, `session.created`, `session.idle`) | `ctx.event.subscribe` (`filesystem.changed`, `session.compaction.ended`, `session.created`, `session.idle`) |

`setup` awaits the enforcing registrations (`execute.before`,
`permission.evaluate`) before it resolves, so there is no window in which a
tool call runs unguarded; a failure to register either rejects `setup`. The
advisory registrations log `[adlc] … hook NOT registered` and carry on.

**Where notices go.** The v2 server plugin has no toast or app-log API, so the
statusline, preflight and audit notices, advisories and denials are written to
the OpenCode server's **stderr** as `[adlc] <level>: <message>`. Denials also
reach the model as the tool error. `opencode run --standalone --print-logs`
shows the stderr lines in the terminal. Observed on 2.0.20: the background
service's log file (the `log` path printed by `opencode debug paths`) holds only
the host's structured log lines, so under the background service these notices
are not visible there.

**permission.evaluate: dispatched** (observed by `scripts/opencode-live-deny.mjs`
on 2.0.20). The host dispatches it AFTER `execute.before`, for each permission
request its configured rules did not already deny, with the permission action
(`write` and `patch` arrive as `edit`) and project-relative `resources`. A rails
hit is normally thrown earlier by `execute.before`, so on a blocked call the
live proof's treatment run prints `permission.evaluate invoked: no`; the control
run prints `yes`.

### Known v2 gaps

1. **No TUI toasts.** v2 server plugins have no toast channel; a TUI plugin
   module is out of scope. Notices go to stderr (above).
2. **Autocontinue not ported.** v2 has no hook equivalent to
   `experimental.compaction.autocontinue`, so the plugin cannot suppress the
   post-compaction "continue" turn. The fallback: a `session.compaction.ended`
   event marks the session degraded, and on a high-risk ticket its next
   structured mutation is denied by the build gate.
3. **Rail notice fixed at load.** The rail notice appended to the
   `edit`/`write`/`patch`/`apply_patch` descriptions is computed when the tool
   transform runs, so a ticket switched mid-session keeps the notice from load
   until OpenCode reloads its tools. The per-turn `context` injection is always
   current.
4. **Lens child sessions are not removed.** v2's plugin session API has no
   delete, so `adlc_prosecute`'s lens/verifier sessions stay in the session list.
5. **Keyless gates use `ctx.generate.text`.** Because child sessions cannot be
   removed (gap 4), LLM-backed gates run through the stateless
   `ctx.generate.text` (no tools) instead of a child session per prompt, so a
   gate run leaves nothing behind in the session list.
6. **Code Mode `execute` is denied while rails are in force.** Its JavaScript
   carries no vettable target path, so the rails guard fails closed on it like
   any unknown tool. Use the structured tools, or opt it out with
   `ADLC_UNGATED_TOOLS=execute` (spoof guard still applies).

## Rail enforcement — two layers

The integration enforces frozen rails at two layers:

1. **In-session hook (enforcing by default).** The plugin's
   `ctx.tool.hook('execute.before')` denies structured mutations to a frozen rail
   declared by the active ticket: a thrown error in the hook **aborts the tool
   call** — regression-tested end-to-end on OpenCode 2 by
   `scripts/opencode-live-deny.mjs` (`write` and `patch`). That proof runs on a
   **version matrix** in CI: the pinned floor (`@opencode/cli@2.0.20`) as a
   *required* check, plus an *advisory* `opencode-live-latest` job that runs the
   same deny + tool proofs against `@opencode/cli@latest` — so a breaking upstream
   change is visible same-day without blocking unrelated merges (opencode releases
   near-daily). The floor pin is bumped deliberately when the canary shows
   sustained green on a newer line. Every extractable target path is checked
   (`path`, `filePath`, `files[]`, `edits[]`, `patchText` envelopes); a mutating
   or *unknown* tool — including v2's Code Mode `execute` — whose target
   cannot be extracted is denied while rails are in force (fail closed — a
   deliberate tradeoff: an unrecognized third-party write tool must not slip
   past on arg shape; a benign no-target tool a railed build needs can be
   explicitly opted out via `ADLC_UNGATED_TOOLS="tool_a,tool_b"`, which still
   gets the frozen-rail-target spoof guard). A denial reaches the model as the
   tool error; denials and advisory warnings are also written to stderr (the v2
   server plugin has no toast channel — see the gaps below). The
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
  (conflict → fail closed). Schema and full read semantics:
  [the active-ticket pointer](../active-ticket-pointer.md). The active ticket is
  per-worktree state, so parallel work on a second ticket needs its own worktree.
  An unparseable pointer, or an object with no recognized id key, also fails closed.
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
| P4 Build | **Yes** | rails-guard hook (structured + shell) + build-gate context-rot backstop + `filesystem.changed` watcher (suppression/scope/rails) + per-turn context injection + tool-transform rail notice + flail advisory + advisory preflight |
| P5 Prosecute | **Yes** | `/adlc-verify-build` (G4) + 5 prosecutor lenses + verifier + `/adlc-prosecute` |
| P6 Integrate | Partial | `session.idle` advisory gate-manifest audit; the human gate is by design |
| P7 Distill | **Yes** | `/adlc-distill` (Phase E) |

Resolved 2026-07-09 (T33 / Phase 4b): **deterministic P5 runner.** The native
**`adlc_prosecute`** tool drives the fan-out → dedupe → verify → loop-until-dry
protocol in FIRST-PARTY code (`lib/prosecute-runner.mjs` `runProsecution`, over
the tested `@adlc/core` helpers), not by prose-instructing the model to
orchestrate. Each lens and the verifier run in an isolated child session
(`ctx.session.create` → `prompt` → `wait` → `context`) created **as its own
agent** (`agent: "prosecutor-<lens>"`) with **fail-closed read-only
`permissions`**, on that lens's configured `model` — agent frontmatter or
`opencode.json` `agents.<id>.model`, read from `ctx.agent.list()` and passed
to `session.create` explicitly, because OpenCode 2.x does not apply an agent's
model to a session a plugin creates — so each lens can run on a different model (advisory model
diversity; trust-root cross-model review still requires distinct providers and
a signed attestation). v2's `prompt` has no per-call `system` field, so the
authoritative packaged charter always leads the prompt text, ahead of the
diff; repo-local agent files or version drift cannot weaken the reviewer
instructions. A lens agent that is not registered is never named: its call
runs on the session model with the charter. The registered set comes from
`ctx.agent.list()` once per run (bounded at 5 s); a host that cannot list
agents keeps every lens on the session model, and the report says the listing
failed rather than blaming missing agents. A lens whose own model fails is
never retried on the session model, so it cannot silently switch model family.
The tool reports which model answered each lens (from the reply's assistant
message) and which ran on the session model, and labels a run as single-model
(not cross-model) only when every reviewer reported the same, known model. The
`permissions` are a `{ action: "*", resource: "*", effect: "deny" }` rule
followed by one `allow` per read-only tool. v2 evaluates the agent's rules and
then the session's, last-match-wins, so the wildcard denies everything —
whatever the lens agent itself allows — and only the read-only tools re-allow
themselves. Any unlisted tool — `edit`/`write`/`patch`, `shell`, the `subagent`
spawner, Code Mode `execute`, MCP tools, or any future tool — matches only
`"*"` and is **hard-denied**. So a lens reads the diff and *cannot* mutate the
repo, even via a sub-agent or a prompt-injection in the untrusted diff.
Structured verdicts come back as fenced JSON (there is no server-side
structured-output mode); an unparseable verdict is **fail-closed** — the
finding is kept as a blocker and flagged unverified, never silently dropped. A
lens whose reply doesn't parse likewise surfaces a blocker (an all-garbage round
can't masquerade as a clean pass), a bounded/incomplete run is reported
`NO-SHIP (INCOMPLETE)` (only a *converged* zero-findings run SHIPs), and a
`git diff` capture failure fails closed rather than reading as an empty change.
The loop is hard-bounded (max rounds / max child sessions) and reports the bound
it hit. `/adlc-prosecute` calls the tool first and keeps the prose protocol as the
fallback when the tool is unavailable. Proven end-to-end by
`scripts/opencode-live-prosecute.mjs` (seeded-defect convergence + write-disable,
CI-required) and `scripts/opencode-live-tool.mjs` (real-binary registration).
v2 exposes no session delete, so lens child sessions are left in the session
list after a run.
This makes OpenCode's P5 the most deterministic of the six integrations.

## Gaps

1. **The permission lever is secondary.** On OpenCode 1.x `permission.ask`
   was never dispatched. On v2, `permission.evaluate` is dispatched (see
   [OpenCode 2](#opencode-2-v2-plugin-api)), but only after `execute.before`,
   which already throws on a rails hit. The enforcing control is the
   `execute.before` throw; the permission hook denies rail-target requests that
   reach the permission step by another route.
2. **Floating leading-`**` rails and in-session directory deletion.** The
   in-session shell guard denies deleting/moving a rail's *fixed-anchor* parent
   (`rm -rf test` vs `test/**`, `rm -rf packages/foo/test` vs
   `packages/*/test/**`, `rm -rf .`). A rail with a *leading* `**` (e.g.
   `**/*.test.mjs`) has no fixed root, so it can't flag an arbitrary parent
   directory in-session without denying every unrelated edit; a directory
   deletion under such a rail is caught by the CI diff gate (authoritative) and,
   for the per-file events it emits, the `filesystem.changed` backstop. Direct writes to
   a matching file are always denied in-session.

Resolved 2026-07-05 (Phase 1): in-session enforcement no longer depends on an
unproven SDK capability — a thrown denial is documented host behavior and the
live deny proof (`scripts/opencode-live-deny.mjs`, required CI) regression-tests
it. See ADR 0004's amendment.

Resolved 2026-07-09 (T32): **compaction survival + slash-command advisories.**
Three more native hooks (originally on the v1 API; the v2 equivalents are in
[OpenCode 2](#opencode-2-v2-plugin-api), and autocontinue is a known v2 gap):

- **`experimental.session.compacting`** appends the active ticket / frozen rails
  / scope block (the same sanitized `buildSystemContext` used per-turn) to the
  compaction prompt, so enforcement context isn't quietly summarized away —
  ENFORCING context that must survive, not a new gate. No-op outside an active
  ADLC build.
- **`experimental.compaction.autocontinue`** DISABLES the post-compaction
  synthetic "continue" turn when the build-gate degradation predicate fires
  (high-risk ticket × compacted/degraded session — the same signal that denies
  structured edits), forcing a human turn instead of letting the agent barrel on
  with a lossy summary. Honors the audited `ADLC_BUILD_GATE_BYPASS=1` (autocontinue
  stays on, override recorded to the manifest). Normal-risk tickets are unaffected.
- **`command.execute.before`** adds two ADVISORY toasts (never blocks — commands
  are human-invoked): a lifecycle-order warning when a phase command runs before
  its prerequisite phase left manifest evidence (e.g. `/adlc-decompose` with no
  recorded spec approval, `/adlc-prosecute` before `coldstart`), and a tamper
  notice when a command's deployed `.opencode/commands/<name>.md` differs
  byte-for-byte from the packaged source. Both fail open.

All three swallow errors and never throw (the host cannot be broken by an
advisory). A required CI proof (`scripts/opencode-live-compaction.mjs`) loads the
shipped plugin entry, runs `setup(ctx)`, and asserts the `compaction` hook is
**registered and behaves** and that a `session.compaction.ended` event makes a
high-risk session's next edit hit the build gate — a registration + behavior
proof, not a host-dispatch proof (compaction is not deterministically forcible
in a headless run).

Resolved 2026-07-08 (Phase 3; v1 hook names — the v2 mapping is in
[OpenCode 2](#opencode-2-v2-plugin-api)): **native-feel surface added (server-side).** Per-turn
the active ticket, frozen rails, and scope are re-stated to the model via
`experimental.chat.system.transform` (context-rot defense), and the frozen rails
are named in the `edit`/`write`/`apply_patch` tool descriptions via
`tool.definition` — so the model is reminded *before* it acts. Ticket fields are
sanitized (control chars stripped, length-capped) before injection so a ticket
can't smuggle prompt directives. A `tool.execute.after` **flail advisory** warns
once per file edited ≥3× in a session (reuses `@adlc/flail-detector`; per-session
state is LRU-bounded and evicted on `session.idle`). The active-ticket
**statusline** (`ADLC <ticket> · P4 enforcing · N rails frozen`) is written to
stderr at `session.created` (it was a TUI toast on OpenCode 1.x).

> **Deferred: the native TUI plugin module.** A full `tui`-export module
> (persistent JSX statusline slot, `DialogConfirm` for the P1→G1 gate, native OS
> notifications) is possible — the `tui` surface shipped in opencode **1.17.0** —
> but it is **deliberately not in this integration yet.** It can only be authored
> in Solid JSX with a build step and can only be verified inside a live opencode
> ≥ 1.17 TUI; this repo's plugin is plain `.mjs` with no build, and the test
> harness runs a headless 1.16.2 binary, so that module could only be shipped as
> unverifiable, guessed-API code — which this integration does not do. It is
> tracked as a follow-on for an environment that can build and live-verify it.
> On OpenCode 2 the statusline goes to stderr; the v2 TUI plugin module stays
> out of scope.

Resolved 2026-07-08 (Phase 2; v1 event names — on v2 the same backstops ride
`session.compaction.ended` and `filesystem.changed`, and v2's shell tool is
`shell`): **bash is now gated in-session** via the
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
discard unrelated in-progress work). `apply_patch` envelopes (v2: `patch`'s
`patchText`) are parsed for in-band targets so GPT-5-class models (where a patch
tool is the ONLY mutator)
stay path-transparent. The shell classifier segment-splits chained commands so a
read-only prefix can't shadow a later mutator.

## Maintenance

Assumptions decay after model or repo drift. Two parity pieces (T34) handle it:

- **`/adlc-maintain`** runs the deterministic, keyless decay checks on demand:
  `adlc skill-rot .opencode/skills` (C10 — stale skill validation metadata),
  `adlc model-ratchet --dry-run` (C12 — the highest-churn files to re-prosecute),
  and `adlc ticket-prune` (stale shipped tickets, dry-run).
- **`prosecutor` meta-agent** (`@prosecutor`, the 7th agent alongside the five
  lens agents + verifier) runs the three deterministic review-evidence gates over
  a change — `adlc hollow-test`, `adlc behavior-diff`, `adlc review-calibration` —
  and reports an evidence-backed verdict. It is complementary to the multi-lens
  `adlc_prosecute` loop: mechanical gates vs. independent model judgment.
- **Weekly cron**: deploy `docs/ci/adlc-maintenance.yml` — it scans `.opencode/skills`
  among the skill roots and runs the deterministic checks.
- **Gate-fuzzing calibration is NOT run automatically.** It is both LLM-backed
  and requires an OS sandbox (`bwrap`/`sandbox-exec`), so neither `/adlc-maintain`
  (developer host) nor the deterministic cron runs it. Exercising gate defeats
  after drift needs a **separate scheduled job that supplies both a model and a
  sandbox** — a deliberate, opt-in setup, not something these parity pieces cover.

## Boundary

- `.adlc/` is the runtime state area for tickets, manifests, and gate evidence.
- The plugin delegates every rail/glob/ticket primitive to `@adlc/core`; it adds
  only the OpenCode-specific hook wiring and the enforcement-capability gate.
- Package READMEs remain the source of truth for exact flags, schemas, and exit codes.
