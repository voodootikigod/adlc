# Adopt the ADLC in Cursor

Wire the Agentic Development Lifecycle into [Cursor](https://cursor.com) using its
**native** extension surfaces — hooks, rules, and commands. Cursor has no plugin
marketplace, so the integration ships as a small Node package
(`plugins/adlc-cursor`) plus a scaffolder that writes the `.cursor/` config into
your repo.

> Companion to [Claude Code](./claude-code.md), [OpenCode](./opencode.md), and
> [Codex](./codex.md). Design rationale: [ADR 0006](../adr/0006-adlc-cursor-integration.md).

## Status

**Native parity shipped.** The in-session rails-guard is now surrounded by the
full phase command suite, the `/adlc-prosecute` sequential five-lens prosecution
loop, and hook parity (a single `preToolUse` dispatcher, the `afterFileEdit`
audit + flail notice, and an advisory `beforeShellExecution` reminder). A live
deny-proof against a real Cursor binary remains the one GA gate (see
[Gaps](#gaps)).

## What you get

- **`preToolUse` dispatcher hook** — runs the rails decision **first** (a frozen-rail
  edit is denied) and, only when rails allow **and** `ADLC_BUILD_GATE_ENFORCEMENT=1`,
  consults the advisory buildgate. One entry, so a second hook can never mask a rails
  deny. A rails deny is returned verbatim.
- **`afterFileEdit` audit hook** — surfaces a loud notice when a frozen rail was
  edited, plus a flail (edit-churn) reminder from `@adlc/flail-detector`. Cursor's
  `afterFileEdit` fires *after* the write and **cannot block**, so this is
  observational only.
- **`beforeShellExecution` advisory** — string-matches obvious shell writes to the
  active ticket's rails and reminds the agent that the CI gate catches rail edits.
  It **never denies** and is **trivially bypassable** — an honesty nudge, not a control.
- **Command palette** — the scaffolder deploys the bare `/adlc-*` phase suite into
  `.cursor/commands/` (init, ticket, spec, approve-spec, decompose, verify-build,
  prosecute, distill, maintain).
- **`.cursor/rules/adlc.mdc`** — the ADLC phase-router rule, available to the agent
  in-session.

The **buildgate is advisory, disabled by default** (opt in with
`ADLC_BUILD_GATE_ENFORCEMENT=1`), and has **NO unbypassable backstop** — unlike
the rails guard, nothing at commit time enforces its verdict (its depth signal is
an agent-writable `.adlc/` file). It exists to slow a flailing session, not to gate
merges. The `stop`-audit and `preflight` hooks ship **disabled** (unverified Cursor
events); opt in with `--wire-unpinned` / `ADLC_CURSOR_WIRE_UNPINNED=1`.

## Install

`@adlc/cursor` is published on npm and folds into the lockstep `/release`:

```sh
npm install -g @adlc/cli          # the gate toolkit the hooks/commands shell out to
npx @adlc/cursor .        # bootstrap the scaffold into the current repo
```

`npx @adlc/cursor` works because the package's single `bin` entry
(`adlc-cursor-scaffold`) resolves for the bare package name — passing a path
argument (`.` for the current repo) is forwarded straight to the scaffolder.

Developing against a checkout instead? Run the scaffolder from source:

1. Install the gate toolkit (the hooks/commands shell out to the `adlc` binary):

   ```sh
   npm install -g @adlc/cli
   ```

2. Install the repo's workspace dependencies so the rails-guard hook can resolve
   `@adlc/core` at runtime (the bootstrap scaffolder itself has no third-party
   dependency, but the hook it wires imports `@adlc/core`):

   ```sh
   cd /path/to/adlc && npm install
   ```

3. Bootstrap from the plugin source (idempotent — **merges** into any existing
   `.cursor/hooks.json`; if that file is present but unparseable it is preserved
   verbatim in a `.bak` sibling before a fresh one is written, never silently
   dropped):

   ```sh
   node /path/to/adlc/plugins/adlc-cursor/lib/scaffold-cli.mjs .
   ```

   This writes `.adlc/config.json`, `.cursor/hooks.json` (wiring the three pinned
   hooks — the `preToolUse` dispatcher, the `afterFileEdit` audit, and the
   `beforeShellExecution` advisory), `.cursor/rules/adlc.mdc`, and **deploys the
   `/adlc-*` command palette into `.cursor/commands/`**. Once the commands are on
   disk you can drive every phase from inside Cursor — including re-running this
   bootstrap via the `/adlc-init` command (`/adlc-ticket`, `/adlc-prosecute`, …).

   **Upgrading a pre-command-suite scaffold.** `ensureRule()` never overwrites an
   existing `.cursor/rules/adlc.mdc`, so a repo scaffolded before the command suite
   landed keeps its old router rule with no command references (and re-running the
   scaffolder will not refresh it). To upgrade: delete `.cursor/rules/adlc.mdc` and
   re-run the scaffolder — it regenerates the current rule (the hooks and the
   `.cursor/commands/` palette update on every run).

4. Verify locally (no Cursor binary required):

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
   set **from the trusted base ref** and rejects any PR that edits a path frozen
   there, regardless of how the edit was made. **Make it a required check.**

   **Private-repo / free-plan caveat:** on a private repo on GitHub's free plan,
   both required-status-check mechanisms (`PUT .../branches/main/protection` and
   `POST .../rulesets`) return 403 ("Upgrade to GitHub Pro or make this repository
   public") — this gate cannot be made a required check there, so a maintainer
   can merge past a failing run. Fold the rail-freeze step into your existing
   required CI job instead — see the "Private-repo fallback" sketch at the bottom
   of [`docs/ci/rails-guard.yml`](../ci/rails-guard.yml).

   **Scope limit (read the template's own SECURITY LIMITATION):** because the rail
   set is read from the base ref, the gate protects rails **already frozen on the
   base branch**. A PR that *introduces* a new rail **and** edits that path in the
   same PR is **not** caught — first-time rails are enforced only once they land on
   the base branch, and the template requires an explicit `acknowledgedNewRailBypass`
   acknowledgement before it can be a required check. Freeze rails in a separate,
   merged commit before the build PR if you need same-PR protection.

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
| P0 Triage | `/adlc-ticket` command | authors a ticket into `.adlc/tickets.json` (shared runtime) |
| P1 Interrogate | `/adlc-spec` · `/adlc-approve-spec` commands | `adlc spec-lint` / `premortem` (`--prompt-only` in-session) + the human approval gate |
| P2 Decompose | `/adlc-decompose` command | `adlc coldstart` / `merge-forecast` |
| **P3 Rail** | **`preToolUse` dispatcher** | **rails-guard (this package + CI gate) + the advisory, default-off buildgate** |
| P4 Build | `/adlc-verify-build` command | targeted tests + `adlc flail-detector` |
| P5 Prosecute | `/adlc-prosecute` command — the sequential five-lens loop | five lenses → dedupe → verifier → loop-until-dry + `adlc hollow-test` / `behavior-diff` + cross-model `adversarial-review`. **Weaker independence** than the siblings' fresh-context subagent fan-out (one context runs all five lenses); run `npx adversarial-review --providers` for the cross-model gate. |
| P6 Integrate | `adlc gate-manifest` | human gate |
| P7 Distill | `/adlc-distill` command | `adlc lesson-foundry` / `rejection-mining` |

The gate-router rule (`.cursor/rules/adlc.mdc`) points the in-session agent at the
right gate for whatever it's doing, and `/adlc-maintain` runs the decay-driven
maintenance sweep (`skill-rot` / `model-ratchet` / `ticket-prune` / `gate-fuzzing`).

## Gaps

These are the real residual gaps after the native-parity build — no overstatement:

- **Live deny-proof** against a real Cursor binary (does `permission: "deny"`
  actually abort the Write on the target platform?), and pinning the exact
  `preToolUse` payload field names — tracked in [ADR 0006](../adr/0006-adlc-cursor-integration.md);
  the adapter extracts the path defensively until then. This is the one GA gate.
- **Prosecutor independence caveat.** `/adlc-prosecute` runs its five lenses
  **sequentially in one context** — Cursor has no subagent fan-out — so it has
  **weaker independence** than the Claude Code / OpenCode fresh-context reviews.
  Run `npx adversarial-review --providers` for the cross-model risk gate.
- **buildgate has no unbypassable backstop.** It is advisory and disabled by
  default (`ADLC_BUILD_GATE_ENFORCEMENT=1`); nothing at commit time enforces its
  verdict (its depth signal is an agent-writable file). Only the rails guard has
  the CI backstop.
- **`stop` / `preflight` hooks ship disabled.** Those Cursor events are not yet
  verified against Cursor's docs, so the stop-audit and preflight scripts ship
  but are **not wired** (opt in with `--wire-unpinned` /
  `ADLC_CURSOR_WIRE_UNPINNED=1`).
- **Shell writes are advisory-only.** `beforeShellExecution` **never denies** and
  the match is trivially bypassable; a Turing-complete shell can't be reliably
  parsed, so shell-driven rail writes are covered only by the CI gate.

## Boundary

The in-session hook is a convenience that fails safe; it is **not** a security
boundary. The frozen-rail guarantee is the CI gate — **for rails already frozen on
the base branch** (see the scope limit above; a rail first introduced in the same
PR is not protected until it lands on the base). Treat the two as designed: the
hook keeps an honest agent on the rails during a build, and CI stops a dishonest or
buggy one at the door — provided the rail was frozen in a merged commit first.
