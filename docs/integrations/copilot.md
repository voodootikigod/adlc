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

**Native plugin built to — and live-verified against — the corrected contract
(CLI 1.0.73).** Skills, hooks, allowlisted MCP gate tools, and read-only
prosecution agents are wired to the deny/config/stdin shapes read from the
shipped Copilot binary, and the **end-to-end live deny-proof is DONE**: real
`copilot -p` model turns against a frozen rail confirmed that the in-session
rails-guard hook **enforces headless** — the deny is a permission *ask* that
defaults to DENY and overrides the `--allow-tool` allowlist — **unless the
session is run with `--allow-all-tools`**, which auto-approves the ask. The live
run *corrected* the earlier static-only read (see
[appendix §1.1/§1.2](./copilot-probe-appendix.md)): the hook is neither
"fail-closed / strongest" (the pre-probe plan) nor "advisory-only / fails open"
(the static over-correction) — it **enforces headless unless `--allow-all-tools`,
and fails open only on a crashed/timed-out hook or `--allow-all-tools`**.

## What it wires

| Primitive | Copilot surface | Notes |
| --- | --- | --- |
| Rail protection | `preToolUse` hook (`adlc-rails-guard.mjs`) | Denies edits to a frozen ticket's rails via a `{reason}` deny-ask. Enforces headless (defaults to deny, overrides `--allow-tool`) unless `--allow-all-tools`. |
| Build-gate context fitness | `preToolUse` hook (`adlc-build-gate.mjs`) | Runs after rails-guard, but **currently inert on Copilot** — the CLI exposes no session transcript to measure context-fitness. See Gaps (e). |
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

Copilot's in-session hook **enforces rails headless** — but through a permission
*ask*, not a hard block, so a single flag (`--allow-all-tools`) neutralizes it.
This is a **doubly-corrected** posture: the pre-probe plan claimed Copilot hooks
were "fail-closed on crash, stronger than agy/Cursor"; a static-only read then
over-corrected to "fail-open, advisory-only." The **live deny-proof** (real
`copilot -p` turns against a frozen rail) settled it precisely — the hook
enforces headless unless `--allow-all-tools`. See
[appendix §1.1/§1.2](./copilot-probe-appendix.md).

### 1. In-session (enforces headless unless `--allow-all-tools`)

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

**The deny is a permission _ask_, and it enforces headless.** The reason becomes
the ask message; whether the tool is blocked depends on the permission mode
(live-verified against 1.0.73, [appendix §1.1](./copilot-probe-appendix.md)):

- **Default OR an explicit `--allow-tool <tool>` allowlist** (even
  `--allow-tool edit`): headless, the ask cannot be answered by a human, so it
  **defaults to DENY → the tool is BLOCKED, overriding the tool allowlist**.
  Rails ARE enforced headless. In the live proof the rail file stayed unchanged,
  Copilot reported *"the edit was blocked… cannot request confirmation in
  non-interactive mode,"* and the hook's shell classifier also blocked a
  `printf > file` Bash workaround.
- **`--allow-all-tools` / `--yolo`**: installs `allowAllPermissionOverride`,
  which **auto-approves the hook's ask → the edit PROCEEDS → the hook is
  NEUTERED**. In the live proof the rail was changed despite a correct
  `{reason}` deny.
- **Interactive**: the human sees the reason (`hookMessage`) and can decline.

**Fail-open windows are only two:** (a) a crashed / timed-out / non-zero /
unparseable hook — `success === false` → decision `undefined` → no ask is
raised, so the tool proceeds under whatever the mode already allows; and (b)
`--allow-all-tools`. Otherwise the hook enforces. (The `failClosed` code paths
in the binary belong to *enterprise managed-settings* determination, a separate
mechanism unrelated to hook execution errors.)

The adapter narrows window (a) within the process: it is zero-dependency,
defensive, and wrapped so that any **internal** error is converted into a deny
object rather than throwing (application-level fail-safe). An **OS-level kill or
a blown `timeoutSec` budget** still kills the process before it can print — a
genuine fail-open window the adapter cannot close, which is why the CI gate is
the hard backstop. **Consequently the fleet adapter defaults to an explicit
`--allow-tool write --allow-tool shell` allowlist (never `--allow-all-tools`)**,
so non-rail edits run unattended while rail edits are blocked by the hook;
`allowAllTools: true` is an opt-in for CI-gate-only autonomy.

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
| **P3 Rail** | **`preToolUse` hooks** | **rails-guard (enforces headless via deny-ask unless `--allow-all-tools`) + CI `rails-guard-ci` (unbypassable hard tier) + the advisory build-gate** |
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
`copilot -p` headless path is text-output only — no JSON mode), run the
cross-model gate `npx adversarial-review --providers` as the independence
backstop. This is the same cross-model P5 fallback the Cursor integration
documents.

## Gaps / Caveats

These are the real residual gaps after building to — and live-verifying — the
corrected contract; no overstatement, no understatement:

- **(a) Two fail-open windows, and only two.** Verified in
  [appendix §1.2](./copilot-probe-appendix.md): the in-session hook fails open
  **only** when (i) the hook process reports `success === false` (crash, non-zero
  exit, timeout, or unparseable stdout) so no ask is raised and the tool
  proceeds, or (ii) the session is run with `--allow-all-tools` / `--yolo`, which
  auto-approves the deny-ask. In every other headless posture — default or an
  explicit `--allow-tool` allowlist — the deny-ask **defaults to deny and blocks
  the tool, overriding the allowlist**. The adapter narrows window (i) by
  converting any **internal** error into a deny object (never throwing to the
  OS), but an **OS-level kill or a blown `timeoutSec` budget** cannot be closed
  in-process; that is a Copilot infrastructure limitation, not an ADLC choice.
- **(b) The CI diff gate is the unbypassable hard tier.** `rails-guard-ci` — the
  commit-time rail-freeze diff gate — covers **both** fail-open windows in (a)
  (hook crash and `--allow-all-tools`) and enforces rail immutability regardless
  of how the edit was made. The in-session hook enforces headless unless
  `--allow-all-tools`; the CI gate is the tier that is never bypassable. Make it
  a required check.
- **(e) The build-gate is currently INERT on Copilot.** `adlc-build-gate.mjs`'s
  context-fitness check (deny a high-risk build when the session's tool-call
  depth / transcript size is degraded) needs a session transcript. Copilot 1.0.73's
  `preToolUse` stdin exposes **none** — only `{ sessionId, timestamp, cwd, toolName,
  toolArgs }` (appendix §2.1) — so `transcriptPath` is always undefined, the hook
  always takes the advisory-allow early-exit, and it **never denies on Copilot**. It
  ships wired (harmless, zero-cost) so it activates automatically if Copilot ever
  exposes a transcript/log field. Until then, Copilot context-rot protection is
  **not** provided by this gate — it rests on operator discipline and the P4 flail
  advisory. (On Claude Code / Codex, whose stdin carries `transcript_path`, this
  gate is fully active; this gap is Copilot-specific.)
- **(c) VS Code Copilot hooks are Preview.** The hook surface this integration
  targets is documented by GitHub as **Preview** status in the VS Code Copilot
  path; its contract may shift, and this doc will be re-pinned against the
  appendix if it does.
- **(d) Live deny-proof: verified once, and re-runnable — but NOT in default CI.**
  The end-to-end deny behavior was proven with real `copilot -p` model turns
  against a frozen rail on CLI 1.0.73 using an entitled personal account
  ([appendix §1.1](./copilot-probe-appendix.md)) — the rail edit was blocked
  under the explicit-allowlist posture and proceeded only under `--allow-all-tools`.
  (An earlier attempt hit a feature-entitlement `403` initially mis-surfaced as an
  org-policy denial; it was resolved with an entitled account, not a contract
  change.) **Coverage caveat, stated plainly:** default CI proves only the deny
  *shape* (`scripts/copilot-install-smoke.mjs` runs the hook on synthetic stdin and
  asserts `{reason}` + exit 0) — it does **not** exercise the real CLI, so a future
  Copilot release that changed hook semantics could ship green while these docs
  still claimed enforcement. The regression guard for that is
  `scripts/copilot-live-deny.mjs` (control run under `--allow-all-tools` lands the
  edit; treatment run under an explicit allowlist blocks it; a third run proves
  `--deny-tool shell` beats `--allow-all-tools`), which drives the real binary. It
  needs an entitled login and AI credits, so it runs as a **daily scheduled drift
  canary** — `.github/workflows/copilot-live-canary.yml` (cron + `workflow_dispatch`),
  which skips cleanly until a `COPILOT_CLI_TOKEN` secret is configured and then fails
  loudly if Copilot's hook-enforcement semantics drift. It is deliberately **not** a
  required per-PR check (an entitled account can't gate every PR). You can also run it
  locally: `ADLC_COPILOT_LIVE_INSTALL=1 node scripts/copilot-live-deny.mjs --require`.

## Boundary

The in-session hook **enforces rails headless** (the deny-ask defaults to deny
and overrides `--allow-tool`) — but it is neutered by `--allow-all-tools` and by
a crashed/timed-out hook, so it is not the unbypassable boundary. The
frozen-rail guarantee is the CI gate `rails-guard-ci` — for rails already frozen
on the base branch — which covers both fail-open windows. Treat the two as
designed: the hook blocks rail edits during a headless build (as long as the
fleet adapter's default allowlist is used, not `--allow-all-tools`), and CI
stops a dishonest, buggy, or allow-all'd one at the door — provided the rail was
frozen in a merged commit first.

## Verification

```sh
# Offline manifest, hook, skill, agent, and MCP contract (built to appendix shapes)
node --test plugins/adlc-copilot/test/*.test.mjs plugins/adlc-copilot/hooks/test/*.test.mjs

# Real marketplace add/install smoke — REQUIRES an unrestricted CI account
ADLC_COPILOT_LIVE_INSTALL=1 node scripts/copilot-install-smoke.mjs .
```

The end-to-end **deny-proof is DONE** — real `copilot -p` turns against a frozen
rail on CLI 1.0.73 confirmed the hook enforces headless unless `--allow-all-tools`
([appendix §1.1](./copilot-probe-appendix.md)); only the marketplace
install/uninstall convenience smoke stays gated on an unrestricted CI account
(Gap (d)). See [ADR 0013](../adr/0013-adlc-copilot-integration.md) for the
decision to build to the verified contract, the
[probe appendix](./copilot-probe-appendix.md) for the pinned contract facts, and
[ticket authoring](../ticket-authoring.md) for the shared ticket contract.
