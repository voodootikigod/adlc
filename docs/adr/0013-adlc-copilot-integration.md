# ADR 0013: GitHub Copilot CLI native integration — the 7th ADLC harness, built to the verified contract

**Status:** **Accepted — built to, and live-verified against, the corrected
contract.** `plugins/adlc-copilot` wires ADLC skills, hooks, allowlisted MCP gate
tools, and read-only prosecution agents to the deny/config/stdin shapes read from
a **real** GitHub Copilot CLI binary (1.0.73). The **end-to-end live deny-proof
is DONE**: real `copilot -p` turns against a frozen rail confirmed the in-session
hook enforces headless (the deny-ask defaults to deny, overriding `--allow-tool`)
unless `--allow-all-tools` is passed. Only the marketplace install/uninstall
convenience smoke stays gated on an unrestricted CI account.

**Date:** 2026-07-22
**Deciders:** Chris Williams.

> **Update 2026-07-22 — live deny-proof run.** The static-only read that produced
> the first draft of this ADR ("in-session hook fails open, advisory-only") was
> itself **corrected** by a live end-to-end deny-proof against CLI 1.0.73 on an
> entitled personal Copilot account. The verified mechanism: the hook's `{reason}`
> deny is a permission **ask** that, headless, defaults to DENY and **blocks the
> tool, overriding the `--allow-tool` allowlist** — so rails ARE enforced
> headless **unless** `--allow-all-tools` / `--yolo` auto-approves the ask. The
> only fail-open windows are a crashed/timed-out hook and `--allow-all-tools`.
> The fleet adapter therefore defaults to an explicit `--allow-tool` allowlist,
> never `--allow-all-tools`, and the CI diff gate covers both fail-open windows.
> (An earlier attempt hit a feature-entitlement `403` mis-surfaced as an
> org-policy denial; resolved with an entitled account.) See
> [appendix §1.1/§1.2](../integrations/copilot-probe-appendix.md).

> Companion to [ADR 0003](./0003-adlc-claude-code-plugin.md) (Claude Code),
> [ADR 0004](./0004-adlc-opencode-integration.md) (OpenCode),
> [ADR 0001](./0001-codex-native-adlc-integration.md) (Codex), and
> [ADR 0006](./0006-adlc-cursor-integration.md) (Cursor).

## Context

ADLC already integrates with Claude Code, OpenCode, Codex, Cursor, Pi, and
Antigravity. The **GitHub Copilot CLI** is a top-tier agentic harness with
native skills, hooks, MCP, and plugin surfaces — a strong 7th target.

The original Copilot integration plan carried several **🧪 unverified
assumptions** derived from VS Code / Claude-Code shapes. An adversarial reading
flagged them as load-bearing and unproven, so issue **#240** commissioned a
probe of a real binary. The
[verified contract appendix](../integrations/copilot-probe-appendix.md) (Copilot
CLI **1.0.73**, `darwin-arm64`, read from the shipped `app.js` plus a live
example hook **and a live end-to-end deny-proof**) **overrides** the plan
wherever they conflict. The corrections that reshape this ADR:

1. **The in-session hook enforces headless — unless `--allow-all-tools`.** The
   plan claimed a crashed rails-guard hook would **deny** ("stronger than
   agy/Cursor"); a static-only read then over-corrected to "fails open,
   advisory-only." The **live deny-proof** settled it: the `{reason}` deny is a
   permission **ask** that, headless, defaults to DENY and **blocks the tool,
   overriding the `--allow-tool` allowlist** (rail file stayed unchanged; Copilot
   reported the edit was blocked and could not request confirmation
   non-interactively). It is neutered **only** by `--allow-all-tools` / `--yolo`
   (which auto-approves the ask) or by a crashed/timed-out hook (`success ===
   false` → decision `undefined` → tool proceeds) — the two, and only two,
   fail-open windows (appendix §1.1/§1.2). The `failClosed` paths in the bundle
   belong to enterprise managed-settings determination, unrelated to
   hook-execution errors.
2. **Deny is a non-empty `{reason}` object at exit 0 — not `permissionDecision`,
   not exit 2.** The string `permissionDecision` appears nowhere in the bundle,
   and the exit code is not consulted for the decision (appendix §1.1).

Additional pinned corrections: hook entries use `bash` / `timeoutSec` (not
`command` / `timeout`), and stdin is camelCase `{toolName, toolArgs(JSON
string), cwd}` (not snake_case `{tool_name, tool_input}`).

## Decision

Ship `plugins/adlc-copilot/` as a small Node package that wires Copilot's native
surfaces to ADLC gates, **delegating every rail / glob / ticket / prosecution
primitive to `@adlc/core`** (no re-implementation — same single-source-of-truth
rule as the sibling ADRs). Build strictly to the **verified** contract; do not
restore any pre-probe assumption.

### The key decision: build to the verified contract, correct the plan

- **The in-session `preToolUse` rails-guard hook enforces headless unless
  `--allow-all-tools`.** It denies a frozen-rail edit by printing `{"reason":"ADLC
  rail frozen: <path>"}` to stdout and exiting 0; that deny is a permission
  **ask** that, headless, defaults to DENY and **blocks the tool, overriding the
  `--allow-tool` allowlist** (live-verified). `--allow-all-tools` / `--yolo`
  auto-approves the ask and neuters the hook; a crashed/timed-out hook raises no
  ask. Those are the only two fail-open windows. The adapter is zero-dependency,
  defensive, and wrapped so any **internal** error is converted into a deny
  object rather than throwing (narrowing the crash window); an **OS-kill or blown
  `timeoutSec`** cannot be closed in-process. This corrects **both** the plan's
  "fail-closed, stronger than agy/Cursor" claim **and** the static-only
  "fail-open, advisory-only" over-correction — neither may be reintroduced in any
  doc or matrix cell. The precise posture is **"enforces headless unless
  `--allow-all-tools`; fails open on crash or allow-all."**
- **Consequence in code:** the fleet adapter
  (`packages/fleet/lib/adapters/copilot.mjs`) **defaults to an explicit
  `--allow-tool write --allow-tool shell` allowlist, not `--allow-all-tools`**,
  so rail edits are blocked by the hook while non-rail edits run unattended.
  `allowAllTools: true` is an opt-in for CI-gate-only autonomy.
- **The unbypassable hard tier is the commit-time CI diff gate**
  (`rails-guard-ci`) — the same backstop the sibling integrations and all
  shell-driven edits rely on. It reads the frozen rail set from the trusted base
  ref and rejects any PR that edits a base-frozen rail regardless of how the edit
  was made, covering both fail-open windows (hook crash and `--allow-all-tools`).
  The integration doc and the capability matrix state Copilot's in-session hook
  as **enforcing headless unless `--allow-all-tools`** and the CI gate as the
  **unbypassable hard tier** — not "strongest of the seven," not "advisory-only."
- **Deny contract, verbatim from the binary:** non-empty JSON object with a
  `reason` field on stdout, exit 0. `permissionDecision` and exit-2 signalling
  are **wrong** and are not used.

### Pinned host-contract facts (from the appendix)

```
config file:     hooks.json (version:1; hooks map)
hook entry:      { "type":"command", "bash":"<shell string>", "timeoutSec":<n> }
                 (field is `bash` NOT `command`; timeout is `timeoutSec` NOT `timeout`)
deny decision:   preToolUse → non-empty {reason} object on stdout, exit 0 → permission ASK
                 (empty/{} → allow; exit code NOT consulted; `permissionDecision` absent)
enforcement:     headless deny-ask defaults to DENY → tool BLOCKED, overrides --allow-tool (live-verified)
                 EXCEPT --allow-all-tools/--yolo auto-approves the ask → tool PROCEEDS (hook neutered)
fail mode:       success===false (crash/non-zero/timeout/unparseable) → no ask raised → tool PROCEEDS (fail OPEN)
                 → only two fail-open windows: hook crash, and --allow-all-tools; else the hook ENFORCES
stdin:           { toolName, toolArgs (JSON string, must parse), cwd, [toolResult for post] }  (camelCase)
events wired:    sessionStart, preToolUse, postToolUse, preCompact, subagentStart, subagentStop, agentStop
load paths:      hooks: .github/hooks/*.json, plugin-bundled, ~/.copilot/hooks/
                 skills: .github/skills/, .agents/skills/, .claude/skills/ (byte-share confirmed)
install:         copilot plugin marketplace add voodootikigod/adlc
                 copilot plugin install adlc-copilot@adlc
fleet:           copilot -p "<prompt>" (text output only, no JSON mode); adapter defaults to
                 --allow-tool write --allow-tool shell (NOT --allow-all-tools, which neuters the hook);
                 --deny-tool shell removes all shell
```

### P5 prosecution (delegated, sibling-faithful)

`adlc-prosecute` runs the six read-only prosecution agents (five lenses +
verifier) with the `@adlc/core` dedupe / verifier-majority / loop-until-dry
helpers via a reference-equal shim (`lib/prosecutor.mjs`). Because `copilot -p`
is text-only (no JSON fan-out mode), the cross-model gate
`npx adversarial-review --providers` is the documented independence fallback.

## Threat model

The in-session hook **enforces headless** but has two neutralizers, so it must
not be mistaken for the unbypassable control:

- **`--allow-all-tools` / `--yolo` neuters the hook.** That flag installs
  `allowAllPermissionOverride`, which auto-approves the deny-ask so the rail edit
  proceeds (appendix §1.1). The fleet adapter therefore defaults to an explicit
  `--allow-tool` allowlist and never passes `--allow-all-tools`.
- **A crashed / killed / timed-out hook raises no ask.** `success === false` →
  decision `undefined` → the tool proceeds (appendix §1.2). The adapter's
  internal-error → deny conversion narrows this to only the OS-kill / timeout
  class, but cannot eliminate it.
- The agent controls its environment, so it can leave `ADLC_P4_ENFORCEMENT`
  unset or point the active-ticket selector at a rail-free ticket.
- Bash-driven writes are not rail-gated in-session beyond the hook's shell
  classifier (Turing-complete shell); `--deny-tool shell` can remove shell
  entirely for fleet workers, but that is a fleet-config choice, not the rail
  control.

Mitigation: the unbypassable commit-time CI gate (`rails-guard-ci`) reads the
frozen rail set from the trusted base ref and rejects PRs that edit a base-frozen
rail — covering both fail-open windows (hook crash and `--allow-all-tools`).
**Known scope limit:** a PR that introduces a new rail *and* edits that path in
the same PR is not caught until the rail lands on the base branch —
freeze rails in a separate, merged commit for same-PR protection. This ADR adds
no competing CI workflow.

## Unverified / follow-on

- **Live deny-proof — DONE + re-runnable, but not in default CI.** Real `copilot -p`
  turns against a frozen rail on CLI 1.0.73 (entitled personal account) confirmed
  the hook enforces headless: the rail edit was blocked under the explicit-allowlist
  posture and proceeded only under `--allow-all-tools` (appendix §1.1). An earlier
  attempt hit a feature-entitlement `403` initially mis-surfaced as an org-policy
  denial; resolved with an entitled account, not a contract change.
  **Coverage caveat:** default CI proves only the deny *shape* (the offline
  install-smoke runs the hook on synthetic stdin), NOT real CLI enforcement — so a
  future Copilot release that changed hook semantics could ship green while this ADR
  still claimed enforcement. The regression guard is `scripts/copilot-live-deny.mjs`
  (control run lands the edit under `--allow-all-tools`; treatment run blocks it under
  an explicit allowlist; a third run proves `--deny-tool shell` beats `--allow-all-tools`),
  which drives the real binary. It runs as a **daily scheduled drift canary**
  (`.github/workflows/copilot-live-canary.yml`, cron + `workflow_dispatch`) that skips
  cleanly until a `COPILOT_CLI_TOKEN` secret is configured, then fails loudly on
  enforcement-semantics drift — deliberately NOT a required per-PR check, since an
  entitled Copilot account can't gate every PR. Re-run locally after any Copilot CLI
  upgrade: `ADLC_COPILOT_LIVE_INSTALL=1 node scripts/copilot-live-deny.mjs --require`.
  The marketplace install/uninstall convenience smoke is separately gated on an
  unrestricted CI account.
- **VS Code Copilot hooks are Preview status** — the contract may shift; re-pin
  against the appendix if it does.
- **Enterprise `policy.d` tier** — `strictKnownMarketplaces` is present in the
  1.0.73 bundle, but the `policy.d` string was not found in this build; defer /
  verify before claiming a machine-policy enforcement tier (appendix §6).

## Consequences

Copilot joins the six existing harnesses with a consistent rail contract and the
same unbypassable CI backstop. Its in-session hook **enforces rails headless**
(the deny-ask defaults to deny, overriding `--allow-tool`) **unless
`--allow-all-tools`** is passed — stronger than a purely advisory hook, but
**not** the "strongest of the seven" the plan advertised, since the CI diff gate
remains the only unbypassable tier. Building to the live-verified contract
(`{reason}` deny-ask, never-crash adapter, fleet adapter defaulting to an
explicit `--allow-tool` allowlist rather than `--allow-all-tools`, CI gate
covering both fail-open windows) keeps the seven-harness story honest; the live
deny-proof is DONE and only the marketplace install convenience smoke stays
gated on an unrestricted CI account.
