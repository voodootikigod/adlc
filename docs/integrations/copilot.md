# Adopt the ADLC in the GitHub Copilot CLI

Wire the Agentic Development Lifecycle into the **GitHub Copilot CLI** — the
**7th ADLC harness** — using its native plugin surfaces: hooks, skills, MCP
tools, and read-only prosecution agents. The integration ships as
`plugins/adlc-copilot` with a `plugin.json` manifest and installs from this
repo's plugin marketplace.

> Companion to [Claude Code](./claude-code.md), [OpenCode](./opencode.md),
> [Codex](./codex.md), and [Cursor](./cursor.md). Design rationale:
> [ADR 0013](../adr/0013-adlc-copilot-integration.md). Every enforcement claim
> below is pinned to the verified
> [Copilot probe appendix](./copilot-probe-appendix.md) (#240, CLI 1.0.73) — the
> contract source of truth. Where an earlier plan assumption conflicts with the
> appendix, the appendix wins.

## Status

**Native plugin built to the verified contract (CLI 1.0.73).** Skills, hooks,
allowlisted MCP gate tools, and read-only prosecution agents are wired to the
deny/config/stdin shapes read from the shipped Copilot binary. **One honesty
gate remains:** the end-to-end live install/deny smoke has **not** been run —
the probe account was blocked by an org Copilot policy (`Access denied by policy
settings`), so the agent loop never fired a tool call. It must run behind
`ADLC_COPILOT_LIVE_INSTALL=1` in an unrestricted subscription (see
[Gaps / Caveats](#gaps--caveats)).

## What it wires

| Primitive | Copilot surface | Notes |
| --- | --- | --- |
| Rail protection | `preToolUse` hook (`adlc-rails-guard.mjs`) | Denies edits to a frozen ticket's rails. Advisory-tier (fail-open host). |
| Build-gate context fitness | `preToolUse` hook (`adlc-build-gate.mjs`) | Runs after rails-guard; opt-in, advisory. |
| Ticket / gate context | `sessionStart`, `preCompact`, `subagentStart`, `subagentStop` | Advisory narration via `adlc-lifecycle.mjs context`. |
| Flail detection | `postToolUse` hook | Advisory repeated-failure notice. |
| Gate evidence + review trigger | `agentStop` hooks (`verify`, `review`) | Advisory. |
| Gate tools | `.mcp.json` → `adlc mcp-server` | `adlc_gate`, `adlc_prosecute`. |
| Prosecution lenses | `agents/*.agent.md` | Read-only tool allowlists (six-lens fan-out). |
| Phase routing / bootstrap | `skills/` | `adlc`, `adlc-init`, `adlc-ticket`, `adlc-prosecute`, `adlc-distill`, `adlc-maintain`. |

The rail-decision logic is a verbatim delegation to the canonical `@adlc/core`
classifier (no re-implementation, same single-source-of-truth rule as every
sibling); `lib/prosecutor.mjs` is a reference-equal re-export shim over
`@adlc/core`'s prosecutor registry.

## Install

ADLC releases the CLI and Copilot plugin in lockstep. Install the gate toolkit
first, then add the plugin from this repo's marketplace:

```sh
npm install -g @adlc/cli@latest
copilot plugin marketplace add voodootikigod/adlc
copilot plugin install adlc-copilot@adlc
adlc init --harness copilot
```

`adlc init` bootstraps only the committable `.adlc/` runtime. It may write a
**local** `.adlc/config.json`; do **not** commit that file into a repo that
already has frozen rails on the base branch — CI treats `.adlc/config.json` as a
trust root once any base ticket declares rails. Bootstrap a real config only
through the protected-base ceremony, not as part of installing the plugin.

Then wire the unbypassable CI rail-freeze gate (`rails-guard-ci`) as a required
check — it is the actual enforcement tier (see below).

## Rail enforcement — two layers

Copilot's in-session hook is a **best-effort, advisory** layer, **not** the
control. This is a corrected posture: the pre-probe plan claimed Copilot hooks
were "fail-closed on crash, stronger than agy/Cursor" — the probe proved that
**false**. See [appendix §1.2](./copilot-probe-appendix.md).

### 1. In-session (advisory, fail-open)

The `preToolUse` rails-guard hook denies a frozen-rail edit using the **verified
deny contract**:

> **Deny** = print a **non-empty JSON object** with a `reason` field on stdout
> and **exit 0**: `{"reason":"ADLC rail frozen: <path>"}`. **Allow** = print
> nothing (or `{}`). The reason surfaces downstream as `hookMessage`.

The verified contract corrects two pre-probe assumptions that MUST NOT be
restored:

- Deny is **NOT** `{"permissionDecision":"deny", …}` — the string
  `permissionDecision` does not appear anywhere in the CLI bundle.
- Deny is **NOT** signalled by **exit 2** — the exit code is **not consulted**
  for the decision. A non-empty stdout object at exit 0 is the whole contract.

**Copilot hooks fail _open_.** On hook `success === false` — a crash, non-zero
exit, timeout, or unparseable stdout — the decision is `undefined`, so **no deny
is applied and the tool proceeds**. This is the same weakness as Antigravity and
Cursor, not a strength over them. (The `failClosed` code paths in the binary
belong to *enterprise managed-settings* determination, a separate mechanism
unrelated to hook execution errors.)

The adapter mitigates this within the process: it is zero-dependency, defensive,
and wrapped so that any **internal** error is converted into a deny object
rather than throwing (application-level fail-safe). But an **OS-level kill or a
blown `timeoutSec` budget** kills the process before it can print — a genuine
fail-open window the adapter cannot close. Treat the in-session hook as an
honesty nudge for a cooperating agent, never as a boundary.

### 2. Commit-time (unbypassable)

The real control is the CI rail-freeze diff gate (`rails-guard-ci`) — the same
backstop every sibling integration and shell-driven edit relies on. It reads the
frozen rail set **from the trusted base ref** and rejects any PR that edits a
base-frozen rail regardless of how the edit was made. **Make it a required
check.**

**Scope limit (do not overstate):** because the rail set is read from the base
ref, the gate protects rails **already frozen on the base branch**. A PR that
*introduces* a new rail **and** edits that path in the same PR is not caught
until the rail lands on the base — freeze rails in a separate, merged commit
first for same-PR protection.

## Rail contract

Enforcement is identical to the sibling integrations (engine is `@adlc/core`,
not re-implemented here):

- Active ticket via `ADLC_TICKET` **or** `.adlc/current-ticket.json` (schema and
  read semantics: [the active-ticket pointer](../active-ticket-pointer.md)). A
  conflict between the two fails closed (denied).
- Enforcement is phase-scoped to `ADLC_P4_ENFORCEMENT=1`; otherwise no-op.
- Rails in force = the **single** active ticket's `rails` plus the trust-root
  rails `.adlc/tickets.json` and `.adlc/current-ticket.json` (not a union).
- No-op when the repo is not ADLC-initialized, enforcement is off, or no active
  ticket resolves.
- Symlink aliases whose real target is a frozen rail are resolved and denied.

### Verified host-contract facts (CLI 1.0.73)

- **Hook config** ([appendix §2](./copilot-probe-appendix.md)): entries are
  `{ "type":"command", "bash":"<shell string>", "timeoutSec":<n> }` — the field
  is **`bash`** (not `command`) and the timeout is **`timeoutSec`** (not
  `timeout`), wrapped in `{"version":1,"hooks":{…}}`.
- **Hook stdin** ([appendix §2.1](./copilot-probe-appendix.md)): `pre/postToolUse`
  receives **camelCase** JSON — `toolName` (string), `toolArgs` (a **JSON
  string** that must be parsed), `cwd`, and for post `toolResult`. Not the
  Claude-Code `{tool_name, tool_input}` snake_case shape.
- **Load paths** ([appendix §4](./copilot-probe-appendix.md)): hooks from
  `.github/hooks/*.json`, plugin-bundled, and `~/.copilot/hooks/`; skills read
  `.github/skills/`, `.agents/skills/`, and **`.claude/skills/`** (confirms the
  byte-share open-standard claim).

## Formal ADLC Coverage

| Phase | Surface in Copilot | Mechanism |
| --- | --- | --- |
| P0 Triage | `adlc-ticket` skill | authors a ticket into `.adlc/tickets.json` (shared runtime) |
| P1 Interrogate | `adlc` skill routing | `adlc spec-lint` / `premortem` (`--prompt-only` in-session) + the human approval gate |
| P2 Decompose | `adlc` skill routing | `adlc coldstart` / `merge-forecast` |
| **P3 Rail** | **`preToolUse` hooks** | **rails-guard (advisory) + CI `rails-guard-ci` (enforcing) + the advisory build-gate** |
| P4 Build | `agentStop` verify hook | targeted tests + `adlc flail-detector` |
| P5 Prosecute | `adlc-prosecute` skill + `agents/*.agent.md` | six-lens fan-out → dedupe → verifier → loop-until-dry + cross-model `adversarial-review` (see below) |
| P6 Integrate | `adlc gate-manifest` (MCP `adlc_gate`) | human gate |
| P7 Distill | `adlc-distill` skill | `adlc lesson-foundry` / `rejection-mining` |

The `adlc` phase-router skill points the in-session agent at the right gate, and
`adlc-maintain` runs the decay-driven maintenance sweep.

## §P5 Prosecution — six lenses + adversarial-review fallback

The `adlc-prosecute` skill runs the ADLC P5 adversarial fan-out delegated to
`@adlc/core`'s prosecutor registry (`lib/prosecutor.mjs` is a reference-equal
re-export shim — a reintroduced local copy fails CI):

1. **Six read-only prosecution agents** (`agents/*.agent.md`) — the five
   independent lenses (correctness, security, contract, spec-vs-implementation
   diff, tests) plus the verifier — each with a **read-only tool allowlist** so a
   lens cannot mutate the change it is judging.
2. **Cross-lens dedupe** of findings, **independent verification** of each
   deduped finding by the verifier, and **loop-until-dry** convergence, using the
   pure orchestration helpers (`dedupeFindings`, `survivesVerification`,
   `shouldContinue`) from `@adlc/core`.

**Fallback:** where a live in-session subagent fan-out cannot be exercised (the
`copilot -p` headless path is text-output only — no JSON mode, and the live
in-session hook/agent path is unproven pending the smoke, see Gaps), run the
cross-model gate `npx adversarial-review --providers` as the independence
backstop. This is the same cross-model P5 fallback the Cursor integration
documents.

## Gaps / Caveats

These are the real residual gaps after building to the verified contract — no
overstatement:

- **(a) In-session hook fails open on a crashed / timed-out hook process.**
  Verified in [appendix §1.2](./copilot-probe-appendix.md): a Copilot hook whose
  process reports `success === false` yields **no decision**, so the tool
  proceeds. The adapter mitigates by converting any **internal** error into a
  deny object (never throwing to the OS), but an **OS-level kill or a blown
  `timeoutSec` budget** is a genuine fail-open window that no adapter code can
  close. This is a Copilot infrastructure limitation, not an ADLC choice.
- **(b) The CI diff gate is the unbypassable enforcement tier.** Because (a)
  makes the in-session hook advisory, `rails-guard-ci` — the commit-time
  rail-freeze diff gate — is the only tier that actually enforces rail
  immutability. The in-session `preToolUse` hook is **advisory-tier**; the CI
  gate is **enforcement-tier**. Make it a required check.
- **(c) VS Code Copilot hooks are Preview.** The hook surface this integration
  targets is documented by GitHub as **Preview** status in the VS Code Copilot
  path; its contract may shift, and this doc will be re-pinned against the
  appendix if it does.
- **(d) Live install / deny smoke has NOT been run.** In the probe environment an
  org Copilot policy returned `Access denied by policy settings`, so the agent
  loop never ran, no tool call fired, and the hooks could not be exercised
  end-to-end. All "verified" facts here are read statically from the shipped
  1.0.73 binary (authoritative for contract *shape*); the **end-to-end deny
  behavior** must still be proven behind `ADLC_COPILOT_LIVE_INSTALL=1` in an
  environment with an **unrestricted** Copilot subscription. Until that runs, do
  not claim the live deny-proof has passed.

## Boundary

The in-session hook is a convenience that **fails open**, not a security
boundary. The frozen-rail guarantee is the CI gate `rails-guard-ci` — for rails
already frozen on the base branch. Treat the two as designed: the hook keeps a
cooperating agent on the rails during a build, and CI stops a dishonest or buggy
one at the door — provided the rail was frozen in a merged commit first.

## Verification

```sh
# Offline manifest, hook, skill, agent, and MCP contract (built to appendix shapes)
node --test plugins/adlc-copilot/test/*.test.mjs plugins/adlc-copilot/hooks/test/*.test.mjs

# Real marketplace add/install + end-to-end deny — REQUIRES an unrestricted account
ADLC_COPILOT_LIVE_INSTALL=1 node scripts/copilot-install-smoke.mjs .
```

The live proof is the one outstanding GA honesty gate (Gap (d)). See
[ADR 0013](../adr/0013-adlc-copilot-integration.md) for the decision to build to
the verified contract, the [probe appendix](./copilot-probe-appendix.md) for the
pinned contract facts, and [ticket authoring](../ticket-authoring.md) for the
shared ticket contract.
