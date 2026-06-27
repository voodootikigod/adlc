# Adopt the ADLC in OpenCode

The `@adlc/*` toolkit is a set of gate-shaped CLIs. This plugin brings the
**Agentic Development Lifecycle** into the [OpenCode](https://opencode.ai)
terminal agent: an in-session rail-guard hook plus the `adlc` phase-routing
discovery skill.

> Design and rationale: [OpenCode integration plan](../opencode-integration-plan.md)
> (the authoritative contract) and [ADR 0004](../adr/0004-adlc-opencode-integration.md).
> Adoption guide: [`../opencode.md`](../opencode.md). The full thesis: [`../../ADLC.md`](../../ADLC.md).

## Status

Shipping so far: the rails-guard plugin (`plugins/adlc-opencode/`, plan Phase D),
the discovery skill, the **Phase A command surface** — `/adlc-init`,
`/adlc-ticket`, `/adlc-spec`, `/adlc-approve-spec`, `/adlc-decompose` plus the
gate-bin dependency mapping and deterministic `/adlc-init` scaffolding — and the
**Phase B keyless gate bridge** (`lib/keyless-bridge.mjs`): run any LLM-backed gate
in `--prompt-only` mode, route the prompt(s) to the host model, no API key — and
the **Phase C advisory session hooks** (`session.created` preflight,
`session.idle` gate-manifest audit), and the **Phase E prosecution surface** — the
G4 build gate (`/adlc-verify-build`), the five P5 prosecution subagents
(`@prosecutor-correctness|security|contract|diff|tests`) plus the
`@prosecutor-verifier`, the `/adlc-prosecute` fan-out/verify/loop-until-dry
command, and `/adlc-distill` (P7). With Phase F's CI backstop (merged earlier),
all six plan phases (A–F) now ship.

> **Session hooks — event-name note.** The plan specified `session.created` +
> `session.ended`, but OpenCode has no `session.ended`; the end-of-work signal is
> `session.idle`, which the gate-manifest audit uses. Both hooks are advisory:
> they only surface warnings, never throw, and no-op when the repo is not
> ADLC-initialized.

> **Keyless bridge — SDK dependency (plan §6.4).** The bridge's protocol (extract
> a gate's prompts, ask, thread answers) is implemented and tested, but the
> isolated-sub-context model call depends on a proposed OpenCode SDK extension. The
> `ask` function is capability-gated: it uses the SDK isolated-prompt API when
> present, optionally degrades to the active session model, and otherwise returns
> `null` so callers fail closed rather than silently skip a gate.

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

## Install

```sh
npm install -g @adlc/cli                       # the toolkit, behind one `adlc <tool>` command
npm install -g @opencode-ai/plugin             # peer dependency (>=1.17.11)
# deploy the plugin into your project's OpenCode plugin directory:
#   .opencode/plugin/adlc-opencode/   (or register it in opencode.json "plugin")
```

Local verification:

```sh
node scripts/opencode-install-smoke.mjs .
```

That smoke test validates the plugin manifest, the `tool.execute.before` hook
wiring, skill registration, the `@adlc/core` delegation (the rail engine is not
re-implemented), and runs the real enforcement unit test. It does not require the
`opencode` binary and does not mutate your environment.

## Rail enforcement — two layers

The integration enforces frozen rails at two layers, and **the in-session layer is
deliberately advisory**:

1. **In-session hook (advisory).** The plugin's `tool.execute.before` hook denies
   structured `edit`/`write` to a frozen rail declared by the active ticket. It
   only *actually blocks* when the host OpenCode SDK honors a thrown denial
   (`onFailure: deny`); a runtime capability probe gates this. When the capability
   is unproven the hook runs advisory (it surfaces the violation but cannot block)
   unless `ADLC_ALLOW_ADVISORY_HOOKS=1` is set — otherwise it fails closed. The
   hook also no-ops unless the repo is ADLC-initialized and `ADLC_P4_ENFORCEMENT=1`.
   It is inherently bypassable (the agent controls its own environment and the
   active-ticket selector), so it is **not** the real control.
2. **Commit-time CI gate (mandatory, unbypassable).** The real control is
   [`../ci/rails-guard.yml`](../ci/rails-guard.yml) driving `scripts/rails-guard-ci.mjs`
   — a harness-agnostic diff gate that reads the frozen rail set from the trusted
   base ref and rejects a PR that touches it. Make it a required check. Because it
   inspects the git diff, it already covers OpenCode-authored changes and the
   shell-driven writes the in-session hook cannot see.

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
| P3 Rail | **MVP** | the in-session rails-guard hook (this plugin) + CI gate |
| P4 Build | Partial | rails-guard hook + `session.created` advisory preflight; flail-detection is follow-on |
| P5 Prosecute | **Yes** | `/adlc-verify-build` (G4) + 5 prosecutor lenses + verifier + `/adlc-prosecute` |
| P6 Integrate | Partial | `session.idle` advisory gate-manifest audit; the human gate is by design |
| P7 Distill | **Yes** | `/adlc-distill` (Phase E) |

## Gaps

1. **In-session enforcement depends on host SDK capability.** Until OpenCode's
   plugin SDK is confirmed to honor a thrown denial (`onFailure: deny`), the hook
   is advisory; the CI gate is the real control.
2. **Bash-driven writes are not gated in-session** (Turing-complete shell) — caught
   by the CI diff gate, mirroring the Claude Code posture.
3. **Phase-E orchestration is model-driven.** `/adlc-prosecute` describes the
   fan-out → dedupe → verify → loop-until-dry protocol (the decision helpers in
   `lib/prosecutor.mjs` are unit-tested), but the loop itself is executed by the
   model invoking the subagents, not a deterministic first-party runner — the same
   gap the Codex path documents for P5.
4. **Live deny proof pending.** A maintainer-only end-to-end check against a real
   OpenCode binary (driving an actual edit-to-rail and asserting the block) is the
   remaining GA gate — see ADR 0004.

## Boundary

- `.adlc/` is the runtime state area for tickets, manifests, and gate evidence.
- The plugin delegates every rail/glob/ticket primitive to `@adlc/core`; it adds
  only the OpenCode-specific hook wiring and the enforcement-capability gate.
- Package READMEs remain the source of truth for exact flags, schemas, and exit codes.
