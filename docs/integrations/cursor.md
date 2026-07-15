# Adopt the ADLC in Cursor

Wire the Agentic Development Lifecycle into [Cursor](https://cursor.com) using its
**native** plugin surfaces — hooks, rules, skills, and commands. The integration
ships as `plugins/adlc-cursor` with a `.cursor-plugin/plugin.json` manifest and a
repo marketplace at `.cursor-plugin/marketplace.json`. An npm scaffolder remains
as a legacy/dev fallback that can still copy `.cursor/` config into a consumer
repo.

> Companion to [Claude Code](./claude-code.md), [OpenCode](./opencode.md), and
> [Codex](./codex.md). Design rationale: [ADR 0006](../adr/0006-adlc-cursor-integration.md).

## Status

**Marketplace plugin shipped (T47).** Native parity (T16–T19) plus Cursor's
plugin distribution model: marketplace manifest, relative hooks, default-on
`stop` / `beforeSubmitPrompt`, and `adlc` / `adlc-init` skills. A live deny-proof
against a real Cursor binary remains the one GA honesty gate (see
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
- **Command palette** — the plugin ships the bare `/adlc-*` phase suite
  (init, ticket, spec, approve-spec, decompose, verify-build, prosecute,
  distill, maintain). The legacy scaffolder can still copy them into a project
  `.cursor/commands/` for local-dev installs.
- **`.cursor/rules/adlc.mdc`** — the ADLC phase-router rule, available to the agent
  in-session.

The **buildgate is advisory, disabled by default** (opt in with
`ADLC_BUILD_GATE_ENFORCEMENT=1`), and has **NO unbypassable backstop** — unlike
the rails guard, nothing at commit time enforces its verdict (its depth signal is
an agent-writable `.adlc/` file). It exists to slow a flailing session, not to gate
merges. The `stop`-audit and `preflight` hooks are **on by default** (Cursor-
documented events); opt out of the legacy scaffolder path with `--no-unpinned` /
`ADLC_CURSOR_WIRE_UNPINNED=0`.

## Install

### Preferred — Cursor marketplace plugin

1. In Cursor: **Settings → Plugins → Add marketplace** and paste
   `https://github.com/voodootikigod/adlc`. The root
   [`.cursor-plugin/marketplace.json`](../../.cursor-plugin/marketplace.json)
   lists `adlc-cursor` → `./plugins/adlc-cursor`.
2. Install the `adlc-cursor` plugin (see
   [Cursor plugins](https://cursor.com/docs/reference/plugins)).
3. Install the gate toolkit and initialize only the `.adlc/` runtime:

   ```sh
   npm install -g @adlc/cli
   adlc init --harness cursor
   ```

`adlc init` may write a **local** `.adlc/config.json`. Do **not** commit that
file into a repository that already has frozen rails on the base branch — CI
treats `.adlc/config.json` as a trust root once any base ticket declares rails.
Bootstrap a real config only through the protected-base ceremony (with
`securityMode` and `acknowledgedNewRailBypass`), not as part of installing the
Cursor plugin.

4. Wire the unbypassable CI rail-freeze gate
   ([`docs/ci/rails-guard.yml`](../ci/rails-guard.yml)) as a required check.

Publishing to [cursor.com/marketplace](https://cursor.com/marketplace/publish) is
a human submit step after the plugin layout is green — follow Cursor's checklist;
this repo is already structured for it.

### Legacy / local-dev fallback — npm scaffolder

`@adlc/cursor` remains published on npm for project-local copies of `.cursor/`:

```sh
npm install -g @adlc/cli
npx @adlc/cursor .
```

The scaffolder merges hooks (including `stop` / `beforeSubmitPrompt` by
default). If `@adlc/cursor` is installed in the project (`npm i -D @adlc/cursor`),
hook commands are relocatable `./node_modules/@adlc/cursor/hooks/…` paths;
otherwise they fall back to absolute paths into the scaffolder install so
`npx @adlc/cursor .` still works. It deploys `.cursor/commands/` and creates
`.adlc/config.json`. Prefer the marketplace path so hooks and skills update with
the plugin instead of drifting project copies.

From a source checkout:

```sh
cd /path/to/adlc && npm install
node plugins/adlc-cursor/lib/scaffold-cli.mjs .
node scripts/cursor-install-smoke.mjs .
```

Opt out of stop/preflight on the scaffold path with `--no-unpinned` /
`ADLC_CURSOR_WIRE_UNPINNED=0`.

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
- **Marketplace publish** to cursor.com is documented but the human submit is
  out of band for this repo's automated release.
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
