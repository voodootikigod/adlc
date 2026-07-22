# ADR 0013: GitHub Copilot CLI native integration — the 7th ADLC harness, built to the verified contract

**Status:** **Accepted — built to the verified contract.** `plugins/adlc-copilot`
wires ADLC skills, hooks, allowlisted MCP gate tools, and read-only prosecution
agents to the deny/config/stdin shapes read from a **real** GitHub Copilot CLI
binary (1.0.73). The one outstanding GA honesty gate is the end-to-end live
install/deny smoke, which the probe environment could not run.

**Date:** 2026-07-22
**Deciders:** Chris Williams.

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
example hook) **overrides** the plan wherever they conflict. The two corrections
that reshape this ADR:

1. **The in-session hook fails _open_, not closed.** The plan claimed a crashed
   rails-guard hook would **deny** the write — "stronger than agy/Cursor (both
   fail open)." The binary proves the opposite: on hook `success === false`
   (crash, non-zero exit, timeout, or unparseable stdout) the decision is
   `undefined`, **no deny is applied, and the tool proceeds** (appendix §1.2).
   The `failClosed` paths in the bundle belong to enterprise managed-settings
   determination, unrelated to hook-execution errors.
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

- **The in-session `preToolUse` rails-guard hook is advisory-tier (fail-open).**
  It denies a frozen-rail edit by printing `{"reason":"ADLC rail frozen:
  <path>"}` to stdout and exiting 0. The adapter is zero-dependency, defensive,
  and wrapped so any **internal** error is converted into a deny object rather
  than throwing (application-level fail-safe). An **OS-kill or blown
  `timeoutSec`** remains a genuine fail-open window the adapter cannot close.
  This corrects the plan's "fail-closed, stronger than agy/Cursor" claim, which
  is **false** and must not be reintroduced in any doc or matrix cell.
- **The unbypassable enforcement tier is the commit-time CI diff gate**
  (`rails-guard-ci`) — the same backstop the sibling integrations and all
  shell-driven edits rely on. It reads the frozen rail set from the trusted base
  ref and rejects any PR that edits a base-frozen rail regardless of how the edit
  was made. The integration doc and the capability matrix state Copilot's
  in-session hook as **advisory-tier** and the CI gate as **enforcement-tier** —
  not "strongest of the seven."
- **Deny contract, verbatim from the binary:** non-empty JSON object with a
  `reason` field on stdout, exit 0. `permissionDecision` and exit-2 signalling
  are **wrong** and are not used.

### Pinned host-contract facts (from the appendix)

```
config file:     hooks.json (version:1; hooks map)
hook entry:      { "type":"command", "bash":"<shell string>", "timeoutSec":<n> }
                 (field is `bash` NOT `command`; timeout is `timeoutSec` NOT `timeout`)
deny decision:   preToolUse → non-empty {reason} object on stdout, exit 0 → deny
                 (empty/{} → allow; exit code NOT consulted; `permissionDecision` absent)
fail mode:       success===false (crash/non-zero/timeout/unparseable) → undefined → tool PROCEEDS (fail OPEN)
stdin:           { toolName, toolArgs (JSON string, must parse), cwd, [toolResult for post] }  (camelCase)
events wired:    sessionStart, preToolUse, postToolUse, preCompact, subagentStart, subagentStop, agentStop
load paths:      hooks: .github/hooks/*.json, plugin-bundled, ~/.copilot/hooks/
                 skills: .github/skills/, .agents/skills/, .claude/skills/ (byte-share confirmed)
install:         copilot plugin marketplace add voodootikigod/adlc
                 copilot plugin install adlc-copilot@adlc
fleet:           copilot -p "<prompt>" (text output only, no JSON mode); --deny-tool shell removes all shell
```

### P5 prosecution (delegated, sibling-faithful)

`adlc-prosecute` runs the six read-only prosecution agents (five lenses +
verifier) with the `@adlc/core` dedupe / verifier-majority / loop-until-dry
helpers via a reference-equal shim (`lib/prosecutor.mjs`). Because the live
in-session fan-out is unproven and `copilot -p` is text-only, the cross-model
gate `npx adversarial-review --providers` is the documented independence
fallback.

## Threat model

The in-session hook is **bypassable by design** and must not be mistaken for the
control:

- **Fail-open host.** A crashed, killed, or timed-out hook process applies no
  deny and the tool proceeds (appendix §1.2). The adapter's internal-error →
  deny conversion narrows this to only the OS-kill / timeout class, but cannot
  eliminate it.
- The agent controls its environment, so it can leave `ADLC_P4_ENFORCEMENT`
  unset or point the active-ticket selector at a rail-free ticket.
- Bash-driven writes are not rail-gated in-session (Turing-complete shell);
  `--deny-tool shell` can remove shell entirely for fleet workers, but that is a
  fleet-config choice, not the rail control.

Mitigation: the unbypassable commit-time CI gate (`rails-guard-ci`) reads the
frozen rail set from the trusted base ref and rejects PRs that edit a base-frozen
rail. **Known scope limit:** a PR that introduces a new rail *and* edits that
path in the same PR is not caught until the rail lands on the base branch —
freeze rails in a separate, merged commit for same-PR protection. This ADR adds
no competing CI workflow.

## Unverified / follow-on

- **Live install / deny proof (the GA gate).** The probe account was blocked by
  an org Copilot policy (`Access denied by policy settings`), so the agent loop
  never ran and no tool call fired — the hooks could not be exercised
  end-to-end. The live deny-proof must run behind `ADLC_COPILOT_LIVE_INSTALL=1`
  in an environment with an **unrestricted** subscription. **Do not claim it has
  passed until it does.**
- **VS Code Copilot hooks are Preview status** — the contract may shift; re-pin
  against the appendix if it does.
- **Enterprise `policy.d` tier** — `strictKnownMarketplaces` is present in the
  1.0.73 bundle, but the `policy.d` string was not found in this build; defer /
  verify before claiming a machine-policy enforcement tier (appendix §6).

## Consequences

Copilot joins the six existing harnesses with a consistent rail contract and the
same unbypassable CI backstop. Its in-session hook enforcement is **advisory
(fail-open)** — the same tier as Antigravity and Cursor, **not** the "strongest
of the seven" the plan advertised. Building to the verified contract (`{reason}`
deny, never-crash adapter, CI gate as the real control) keeps the seven-harness
story honest, and the outstanding live smoke is the single remaining GA gate.
