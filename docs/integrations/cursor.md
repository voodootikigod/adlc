# Adopt the ADLC in Cursor

Wire the Agentic Development Lifecycle into [Cursor](https://cursor.com) using its
**native** extension surfaces — hooks, rules, and commands. Cursor has no plugin
marketplace, so the integration ships as a small Node package
(`plugins/adlc-cursor`) plus a scaffolder that writes the `.cursor/` config into
your repo.

> Companion to [Claude Code](./claude-code.md), [OpenCode](./opencode.md), and
> [Codex](./codex.md). Design rationale: [ADR 0006](../adr/0006-adlc-cursor-integration.md).

## Status

**MVP shipped — the in-session rails-guard hook + the gate-router rule.** This is
the smallest increment that makes rail enforcement real inside Cursor. The phase
command suite, the prosecutor subagents, and a live deny-proof against the Cursor
binary are follow-on (see [Gaps](#gaps)).

## What you get

- **`preToolUse` rails-guard hook** — before Cursor's agent runs a `Write`/`Edit`,
  the hook denies edits to paths frozen by the active ticket.
- **`afterFileEdit` audit hook** — surfaces a loud notice when a frozen rail was
  edited. Cursor's `afterFileEdit` fires *after* the write and **cannot block**,
  so this is observational only.
- **`.cursor/rules/adlc.mdc`** — the ADLC phase-router rule, available to the agent
  in-session.

## Install

1. Install the toolkit and this package:

   ```sh
   npm install -g @adlc/cli
   npm install --save-dev @adlc/cursor-package    # or reference the repo path
   ```

2. Bootstrap (idempotent — merges into any existing `.cursor/hooks.json`):

   ```sh
   node ./node_modules/@adlc/cursor-package/lib/scaffold-cli.mjs .
   ```

   This writes `.adlc/config.json`, `.cursor/hooks.json` (wiring the rails-guard +
   audit hooks), and `.cursor/rules/adlc.mdc`. Inside Cursor you can also run the
   `/adlc-init` command.

3. Verify locally (no Cursor binary required):

   ```sh
   node scripts/cursor-install-smoke.mjs .
   ```

## Rail enforcement — two layers

Cursor's hooks are a **best-effort, in-session** layer, not the control:

1. **In-session (advisory).** The `preToolUse` hook returns
   `{ "permission": "deny" }` on a frozen-rail edit. Cursor *should* block it — but
   `permission: "deny"` has [open reliability reports](https://forum.cursor.com/t/hooks-returning-deny-do-not-seem-to-block-tool-execution-possible-security-concern/154377),
   and `afterFileEdit` cannot block at all. The hook is configured `failClosed:
   false` so a hook bug can never brick your editor. Bash/shell writes are **not**
   gated in-session (a Turing-complete shell can't be reliably parsed).

2. **Commit-time (unbypassable).** The real control is the CI rail-freeze gate
   ([`docs/ci/rails-guard.yml`](../ci/rails-guard.yml)). It reads the frozen rail
   set from the trusted base ref and rejects any PR that touched a rail, regardless
   of how the edit was made. **Make it a required check.**

## Rail contract

Enforcement is identical to the sibling integrations (the engine is `@adlc/core`,
not re-implemented here):

- Active ticket via `ADLC_TICKET` **or** `.adlc/current-ticket.json`; a conflict
  between the two fails closed (denied).
- Enforcement is phase-scoped to `ADLC_P4_ENFORCEMENT=1`; otherwise no-op.
- Rails in force = the **single** active ticket's `rails` plus the trust-root rails
  `.adlc/tickets.json` and `.adlc/current-ticket.json` (not a union across tickets).
- No-op when the repo is not ADLC-initialized, enforcement is off, or no active
  ticket resolves.
- Symlink aliases whose real target is a frozen rail are resolved and denied.

## Formal ADLC Coverage

| Phase | Surface in Cursor | Mechanism |
| --- | --- | --- |
| P0 Triage | `.adlc/tickets.json` | author a ticket (shared runtime) |
| P1 Interrogate | `adlc spec-lint` / `premortem` | dispatcher (`--prompt-only` in-session) |
| P2 Decompose | `adlc coldstart` / `merge-forecast` | dispatcher |
| **P3 Rail** | **`preToolUse` rails-guard hook** | **this package + CI gate** |
| P4 Build | `adlc flail-detector` | dispatcher |
| P5 Prosecute | `adlc hollow-test` / `behavior-diff` | dispatcher |
| P6 Integrate | `adlc gate-manifest` | human gate |
| P7 Distill | `adlc lesson-foundry` | dispatcher |

The gate-router rule (`.cursor/rules/adlc.mdc`) points the in-session agent at the
right gate for whatever it's doing.

## Gaps

- **Phase command suite** (`.cursor/commands/adlc-*`) beyond `/adlc-init` — follow-on.
- **Prosecutor subagents** (the 5-lens P5 prosecution) — follow-on.
- **Live deny-proof** against a real Cursor binary, and pinning the exact
  `preToolUse` payload field names — tracked in [ADR 0006](../adr/0006-adlc-cursor-integration.md);
  the adapter extracts the path defensively until then.
- **Shell-write gating** in-session — out of scope by design; covered by the CI gate.

## Boundary

The in-session hook is a convenience that fails safe; it is **not** a security
boundary. The frozen-rail guarantee is the CI gate. Treat the two as designed: the
hook keeps an honest agent on the rails during a build, and CI stops a dishonest or
buggy one at the door.
