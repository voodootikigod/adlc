# Plan: Installing & Integrating ADLC into Claude Code

**Status:** Superseded — see [`docs/adr/0003-adlc-claude-code-plugin.md`](../adr/0003-adlc-claude-code-plugin.md) for the accepted design record. · **Original Status:** Proposal · **Branch:** `feat/claude-code-integration` · **Date:** 2026-06-14

## 1. Problem

Today ADLC ships as 20 independent `@adlc/*` npm CLIs. They are composable and
gate-shaped, but to *use* the lifecycle a person must:

1. Know which tool maps to which lifecycle phase (P0–P7, D1–D3).
2. Install or `npx` each tool individually.
3. Remember to run the right gate at the right moment, by hand.
4. Wire exit codes into their own workflow, and (for LLM-backed tools) supply
   API keys.

That is a toolbox, not a lifecycle. The thesis's own claim is that enforcement
must live **at the tool layer, not the prompt layer** ("F5 routes around
instructions; it cannot route around a hook"). A pile of CLIs a human must
remember to invoke is exactly the prompt-layer dependence ADLC argues against.

**Goal:** one-step install that makes the *whole* ADLC embraceable from inside
Claude Code, with gates firing automatically at the correct lifecycle moments.

## 2. Design thesis: ship Appendix F as a plugin

ADLC.md Appendix F ("Harness Primitive Map") already maps each lifecycle organ
to a Claude Code primitive. This plan is the implementation of that table. We do
not invent new structure — we bind existing CLIs to the primitives the thesis
already nominated.

Two load-bearing decisions fall out of that mapping:

- **The unit of distribution is a Claude Code plugin** (`.claude-plugin/`,
  `commands/`, `agents/`, `skills/`, `hooks/`), delivered through a marketplace
  manifest so install is `/plugin install`.
- **Inside Claude Code, Claude is the model.** Every LLM-backed CLI already has
  `--prompt-only`, which prints the exact prompt and exits 0. Skills run the
  tool with `--prompt-only`, hand the prompt to the agent, and the agent
  returns the judgment. **No external API keys are required to use the
  lifecycle.** This is the single biggest reduction in install friction and is
  only possible because the CLI contract guarantees `--prompt-only` everywhere.

## 3. Primitive mapping (the heart of the plan)

| Lifecycle organ (ADLC phase) | CLI(s) | Claude Code primitive | Default posture |
|---|---|---|---|
| Preflight (D2 Phase 0) | `preflight` | **SessionStart hook** | Advisory: warn, never block session |
| Rail freeze (P3 / C5) | `rails-guard` | **PreToolUse hook** on `Edit`/`Write`/`MultiEdit` (in-session, precise) + the diff-based `rails-guard` gate in CI (commit-time backstop — template at `docs/ci/rails-guard.yml`, script `scripts/rails-guard-ci.mjs`) | Block structured edits to paths declared `rails` in a ticket + freeze the `.adlc/tickets.json` trust root; no-op when none declared. **Bash is not gated in-session** (a shell can't be reliably parsed — see the ADR); rail mutations via Bash are caught by the unbypassable CI diff gate at commit time |
| Flail supervision (P4 / C6) | `flail-detector` | **PostToolUse hook** reading a bounded recent window of the transcript | Advisory: surface repeat/churn warnings (scope checks need ticket context — future) |
| Spec interrogation (P1) | `spec-lint`, `premortem`, `parallax` | **Skills** + slash commands, run `--prompt-only` | Model-invoked |
| Decomposition (P2) | `coldstart`, `model-router`, `merge-forecast` | **Skills** + slash commands | Model-invoked |
| Hard-bug repair (P4 / C7) | `consensus-fix` | **Slash command** (explicit, expensive) | User-invoked |
| Prosecution (P5) | `hollow-test`, `behavior-diff`, `review-calibration` | **Subagent** ("prosecutor") + skills | Invoked before merge |
| Gate evidence (C11) | `gate-manifest` | **Stop hook** audits the evidence chain (`verify`); the gates themselves `record` | Advisory: warn only if the chain is broken |
| Distill (P7) | `lesson-foundry`, `rejection-mining` | **`/adlc-distill`** (manual) + scheduled Claude routine | Idle-time, budgeted; prompt-only (no keys) |
| Maintenance (C10/C12 + fuzzing) | `skill-rot`, `model-ratchet`, `gate-fuzzing` | **`/adlc-maintain`** (manual) + **CI cron** for the deterministic checks (`docs/ci/adlc-maintenance.yml`) | Idle-time, budgeted; advisory |
| Orchestration lane (D0) | the toolkit's own build pattern | **Workflow script** / `/adlc-run` orchestrator command | Opt-in |
| Knowledge layer (P7) | the skills themselves | **Skills with progressive disclosure** | Always available, lazily loaded |

## 4. What we build

### 4.1 A dispatcher CLI — `@adlc/cli` (NEW package, prerequisite)

Hooks and commands need a *stable, single* command to shell out to. Twenty
separate bins, or `npx @adlc/<tool>` per call, give an unstable command surface
(bad for prompt-cache stability — §6 of the thesis) and a slow/networked first
run.

Introduce one umbrella bin, `adlc`, that dispatches: `adlc spec-lint …`,
`adlc rails-guard …`, etc. It depends on all 20 packages, so a single
`npm i -g @adlc/cli` installs the whole suite, and every hook/command calls one
stable prefix. This is the only new *code* artifact the plan strictly requires;
everything else is plugin metadata, prompts, and docs.

### 4.2 The plugin layout

```
.claude-plugin/
  plugin.json            # manifest: name, version, description
  marketplace.json       # so `/plugin marketplace add voodootikigod/adlc` works
commands/
  adlc-init.md           # bootstrap .adlc/, write tickets.json skeleton
  adlc-ticket.md         # author/triage a ticket (P0 — fills the gap, see §5)
  adlc-spec.md           # spec-lint + premortem + parallax over a spec
  adlc-decompose.md      # coldstart + model-router + merge-forecast
  adlc-prosecute.md      # invoke the prosecutor subagent
  adlc-consensus-fix.md  # explicit hard-bug fan-out
  adlc-run.md            # orchestrator: run a ticket through P1→P7
  adlc-status.md         # show gate-manifest evidence + open tickets
agents/
  prosecutor.md          # P5 reviewer: hollow-test, behavior-diff, calibration
skills/
  adlc/SKILL.md          # meta-skill: phase-routing flowchart (discovery)
  adlc-spec-shaping/
  adlc-prosecution/
  ... (one per phase cluster, progressive disclosure)
hooks/
  hooks.json             # SessionStart, PreToolUse, PostToolUse, Stop bindings
  preflight.sh
  rails-guard.sh
  flail-detector.sh
  gate-manifest.sh
```

### 4.3 The discovery skill

Mirror the `using-agent-skills` meta-skill pattern already present in this
environment: a single `adlc` skill whose body is a phase-routing flowchart
("new spec? → adlc-spec-shaping; tests written, pre-merge? → adlc-prosecution;
…"). This is how the model embraces the lifecycle *in total* without the user
memorizing 20 tools.

### 4.4 Hook contract

All hooks call the dispatcher with `--json`, parse the exit code, and translate
to Claude Code hook semantics:

- `exit 0` → allow / pass (and for advisory hooks, optionally surface a note).
- `exit 2` (gate fail) → for `rails-guard` PreToolUse, **deny** the Edit/Write
  with the gate message; for advisory hooks, surface a warning but allow.
- `exit 1` (op error) → posture is **asymmetric by hook role**, not uniform:
  - *Advisory hooks* (preflight, flail-detector, gate-manifest): log and allow
    — a broken advisory tool must never block the user.
  - *Enforcement hook* (`rails-guard` PreToolUse): the response depends on
    whether rails are in scope for this edit. **If the ticket declares no `rails`
    paths**, op-error allows (the hook is a no-op anyway, so a broken binary
    cannot brick a clean repo). **If rails are declared and the guard cannot
    produce a trustworthy decision** (missing `adlc` binary, malformed or
    unreadable `.adlc/tickets.json`, parser/shim failure), the hook **fails
    closed: deny the edit** with a diagnostic naming the exact cause. A blocking
    gate that fails open on a broken dependency is not a gate — F5 would simply
    break the dependency to route around it.

Recovery from a fail-closed state is an *explicit, auditable* override, never a
silent allow: an `ADLC_RAILS_BYPASS=1` environment escape hatch (logged to the
gate-manifest as a recorded bypass) lets a user proceed when the tooling itself
is broken, so the override leaves evidence rather than a hole.

Rail enforcement is the one blocking hook. When **no rails are declared** it is a
pure no-op regardless of tool health — so installing the plugin into a repo that
declares no rails cannot brick editing. The fail-closed behavior activates only
once a ticket opts in by declaring `rails` paths, which is exactly the moment the
user has asked for those paths to be unbypassable.

## 5. Completeness over the ADLC

Phase-by-phase coverage of the integrated surface:

| Phase | Covered by | Status |
|---|---|---|
| P0 Triage | `/adlc-ticket` (NEW command) | **Gap filled by plan** |
| P1 Interrogate | spec-lint, premortem, parallax | ✅ |
| P2 Decompose | coldstart, model-router, merge-forecast | ✅ |
| P3 Rail | rails-guard (PreToolUse hook) | ✅ |
| P4 Build | flail-detector (hook), consensus-fix | ✅ |
| P5 Prosecute | hollow-test, behavior-diff, review-calibration (subagent) | ✅ |
| P6 Integrate | gate-manifest + behavior-diff evidence surfaced to the human | ⚠️ partial (human gate is inherently manual; we surface evidence, we don't automate the judgment) |
| P7 Distill | lesson-foundry, rejection-mining (cron) | ✅ |
| Maintenance | skill-rot, model-ratchet, gate-fuzzing (cron) | ✅ |
| D1 cost | model-router | ✅ |
| D2 time | merge-forecast, preflight, worktrees | ✅ |
| D3 accuracy | parallax | ✅ |

## 6. Identified gaps & risks

1. **Ticket authoring is missing from the toolkit.** Every downstream tool
   *reads* `.adlc/tickets.json` (coldstart, model-router, rails-guard,
   merge-forecast) but **nothing creates it.** Without an authoring step the
   integrated lifecycle has no entry point. The plan fills this with
   `/adlc-init` (skeleton) and `/adlc-ticket` (P0 triage), but note these are
   *new* surface, not a binding of an existing CLI — they are the plan's
   largest net-new responsibility.

2. **CLI delivery vs. plugins not running `npm install`.** Claude Code plugins
   do not run a package install step. Hooks must therefore reach a resolvable
   `adlc` binary. Three options, with the recommendation:
   - (a) Documented prerequisite `npm i -g @adlc/cli` — **recommended**: one
     command, stable, offline after first install.
   - (b) `npx @adlc/cli` per call — zero prerequisite but networked + slow on
     first call in each session; fragile in air-gapped/CI.
   - (c) Vendor the (zero-dep) CLIs inside the plugin and call them via
     `${CLAUDE_PLUGIN_ROOT}` — no prerequisite, but duplicates the suite and
     decouples plugin version from npm version.
   This is an unresolved tradeoff the plan surfaces rather than hides.

3. **`flail-detector` and the session transcript — gap resolved.** Originally
   this was flagged as needing a transcript→log shim. It does not:
   `flail-detector`'s `parseLog` already detects JSONL and walks Claude Code
   transcript tool-use blocks (`input.file_path`, `tool_input`, `edits[]`),
   emitting synthetic `Writing <path>` lines so the scope/churn/repeat signals
   fire natively. The PostToolUse hook therefore passes `transcript_path`
   directly — no shim. (Delivered in Phase C as the advisory `flail` hook.)

4. **Blocking hooks are a footgun — resolved by an asymmetric contract.** A
   `rails-guard` PreToolUse that fails *open* on op-error is no gate at all (F5
   breaks the binary to route around it); one that fails *closed* unconditionally
   bricks editing in any repo with a broken or uninstalled tool. §4.4 resolves
   this asymmetrically: with **no rails declared** the hook is a no-op and
   op-errors allow (clean repos can't be bricked); with **rails declared** an
   untrustworthy decision **fails closed**, with an audited `ADLC_RAILS_BYPASS=1`
   override that records the bypass to the gate-manifest. This must ship with
   explicit acceptance tests:
   - missing `adlc` binary + **no** rails declared → edit allowed (no-op);
   - missing `adlc` binary + rails declared → edit **denied**, diagnostic names
     the missing binary;
   - malformed `.adlc/tickets.json` + rails referenced → edit **denied**;
   - unreadable/permission-denied ticket file + rails referenced → edit
     **denied**;
   - a declared-rails edit with a healthy guard → genuine gate decision (allow
     non-rail path, deny rail path);
   - `ADLC_RAILS_BYPASS=1` on a fail-closed state → edit allowed **and** a bypass
     entry appears in the gate-manifest.

5. **Human gates (P6) cannot be automated** by definition. The plan surfaces
   evidence (`/adlc-status`, gate-manifest) but the integration is a *prompt to
   the human*, not a gate the agent passes. This is correct per the thesis but
   means "embrace the ADLC in total" has a deliberate manual seam.

6. **Cron/scheduled loops require the user's harness to support them** and to
   budget tokens. If the user's Claude Code lacks scheduling, P7/maintenance
   degrades to manual commands. The plan should ship both a cron binding *and*
   `/adlc-distill` / `/adlc-maintain` manual fallbacks.

## 7. Install & use evaluation

**Best-case install (recommended path):**

```sh
npm i -g @adlc/cli                          # one prerequisite, offline after
/plugin marketplace add voodootikigod/adlc  # register
/plugin install adlc@adlc                   # install plugin
/adlc-init                                   # bootstrap .adlc/ in the repo
```

Four steps, no API keys (prompt-only ⇒ Claude is the model), no per-tool
knowledge required (the discovery skill routes). After this, gates fire
automatically: preflight on session start, rail-guard on edits, gate-manifest on
stop, and the model reaches for spec/prosecution skills at the right phases.

**Simplicity score:** strong. The friction collapses from "know + install +
sequence 20 tools + supply keys" to "install once, init once."

**Completeness score:** strong on P1–P5, P7, and the three dials; partial on P0
(filled by new commands, not existing CLIs) and P6 (inherently human).

## 8. Phased delivery

1. **Phase A — dispatcher.** ✅ Shipped `@adlc/cli` umbrella bin. Unblocks every
   hook and command with a stable prefix. (Only net-new code.)
2. **Phase B — plugin skeleton + discovery skill + `/adlc-init`/`/adlc-ticket`.**
   ✅ Shipped. Makes the lifecycle reachable and gives it an entry point.
3. **Phase C — advisory hooks** (SessionStart preflight, PostToolUse flail,
   Stop gate-manifest). ✅ Shipped. Safe, non-blocking; proves the wiring.
4. **Phase D — blocking rail-guard hook** + prosecutor subagent. ✅ Shipped. The
   PreToolUse `rails` hook denies edits to declared rail paths (fail-closed per
   §4.4, `ADLC_RAILS_BYPASS=1` audited override); the `prosecutor` subagent runs
   the P5 review-evidence gates.
5. **Phase E — scheduled maintenance** (lesson-foundry, skill-rot,
   model-ratchet) with manual `/adlc-*` fallbacks. ✅ Shipped. `/adlc-distill`
   (P7: lesson-foundry + rejection-mining, prompt-only) and `/adlc-maintain`
   (skill-rot + model-ratchet + gate-fuzzing) commands; deterministic checks run
   on a weekly cron via `docs/ci/adlc-maintenance.yml`; LLM-backed checks run via
   a scheduled Claude routine (`/schedule`) — no API keys.
6. **Phase F — marketplace publish** + docs. ✅ Shipped. The repo is a Claude
   Code marketplace (`.claude-plugin/marketplace.json` + `plugin.json`);
   `docs/integrations/claude-code.md` is the user adoption guide, linked from the README.
   "Publish" = pushing the branch to GitHub, where the repo itself serves as the
   installable marketplace (`/plugin marketplace add voodootikigod/adlc`).

Each phase is independently shippable and independently useful, matching the
toolkit's own "every tool is one gate" philosophy.
