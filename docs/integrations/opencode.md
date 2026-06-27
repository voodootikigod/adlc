# Adopt the ADLC in OpenCode

The `@adlc/*` toolkit is a set of gate-shaped CLIs. This plugin brings the
**Agentic Development Lifecycle** into the [OpenCode](https://opencode.ai)
terminal agent: an in-session rail-guard hook plus the `adlc` phase-routing
discovery skill.

> Design and rationale: [OpenCode integration plan](../opencode-integration-plan.md)
> (the authoritative contract) and [ADR 0004](../adr/0004-adlc-opencode-integration.md).
> Adoption guide: [`../opencode.md`](../opencode.md). The full thesis: [`../../ADLC.md`](../../ADLC.md).

## Status

This is the **MVP increment**: the rails-guard plugin (`plugins/adlc-opencode/`)
and the discovery skill ship and are tested. The broader lifecycle surface — the
full slash-command suite, the keyless LLM bridge, advisory session hooks, and the
prosecutor lenses — is designed in the integration plan and tracked as follow-on
work (plan Phases A/B/C/E).

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
| P0 Triage | Planned | plan Phase A (`/adlc-ticket`) — follow-on ticket T2 |
| P1 Interrogate | Planned | plan Phase A (`/adlc-spec`) + the `adlc` skill |
| P2 Decompose | Planned | plan Phase A — follow-on T2 |
| P3 Rail | **MVP** | the in-session rails-guard hook (this plugin) + CI gate |
| P4 Build | Partial | rails-guard hook; flail-detection is follow-on |
| P5 Prosecute | Planned | plan Phase E prosecutor lenses — follow-on T5 |
| P6 Integrate | Planned | gate-manifest evidence (human gate) |
| P7 Distill | Planned | plan Phase E (`/adlc-distill`) — follow-on T5 |

## Gaps

1. **In-session enforcement depends on host SDK capability.** Until OpenCode's
   plugin SDK is confirmed to honor a thrown denial (`onFailure: deny`), the hook
   is advisory; the CI gate is the real control.
2. **Bash-driven writes are not gated in-session** (Turing-complete shell) — caught
   by the CI diff gate, mirroring the Claude Code posture.
3. **Lifecycle breadth.** Only P3 ships in this MVP; the command suite, keyless
   bridge, advisory session hooks, and prosecutor lenses are follow-on tickets
   (T2–T5).
4. **Live deny proof pending.** A maintainer-only end-to-end check against a real
   OpenCode binary (driving an actual edit-to-rail and asserting the block) is the
   remaining GA gate — see ADR 0004.

## Boundary

- `.adlc/` is the runtime state area for tickets, manifests, and gate evidence.
- The plugin delegates every rail/glob/ticket primitive to `@adlc/core`; it adds
  only the OpenCode-specific hook wiring and the enforcement-capability gate.
- Package READMEs remain the source of truth for exact flags, schemas, and exit codes.
