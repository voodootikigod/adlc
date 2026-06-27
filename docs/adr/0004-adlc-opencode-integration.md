# ADR: OpenCode integration — rails-guard plugin MVP

**Status:** **Accepted — MVP shipped (P3 rail guard); Phases A/B/C/E follow-on.**
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

- **`input.args.filePath` vs `output.args.filePath`** — official docs and the
  community gist disagree; the handler reads `input` first and falls back to
  `output`. Pinning this against a captured real payload is pending a live install.
- **Live deny proof (AC7)** — a maintainer-only end-to-end test against a real
  OpenCode binary remains the GA gate.
- **TS + bundled `dist/index.js`** — the MVP ships plain `.mjs` (no build step);
  the plan's bundled-distribution form is a follow-on.
- **Phases A/B/C/E** — command suite, keyless bridge, advisory hooks, prosecutor
  lenses (follow-on tickets T2–T5).

## Consequences

Rail enforcement is real in OpenCode for the common structured-edit path, with the
rail engine delegated to a single source of truth. The advisory/CI two-layer model
is honest about what the in-session hook can and cannot guarantee.
