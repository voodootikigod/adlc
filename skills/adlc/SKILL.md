---
name: adlc
description: Routes agentic development work to the right Agentic Development Lifecycle (ADLC) gate. Use when shaping a spec or ticket, deciding how to fan out work to models, protecting frozen rails during a build, prosecuting a change before merge, or distilling repeated review findings into defenses. Triggers on "shape this spec", "is this ticket ready", "freeze these tests", "prosecute this change", "is this safe to merge", "ADLC", "which gate", "spec-lint", "premortem", "coldstart", "rails-guard", "hollow-test", "behavior-diff".
---

# ADLC — phase routing

The Agentic Development Lifecycle treats agentic development as phases with
explicit, machine-checkable **gates**. Each gate is a CLI invoked through the
umbrella dispatcher: `adlc <tool> [args]`. Every tool exits `0` = gate passes,
`1` = operational error, `2` = gate fails. Identify the phase, run the gate.

**You are the model.** Every LLM-backed gate supports `--prompt-only`: it
prints the exact prompt and exits without calling any provider. You do not need
API keys — run the tool with `--prompt-only`, answer the printed prompt
yourself, and apply the judgment. Prefer this over wiring keys.

Prerequisite: the toolkit must be installed (`adlc --version` works). If not,
the user runs `npm i -g @adlc/cli`. Run `adlc init` once per repo to create the
`.adlc/` workspace.

> **This is the harness-neutral skill.** It drives the ADLC entirely through the
> `adlc` CLI, so it works in any agent. If your harness has a **native ADLC
> plugin** — Claude Code, Codex, Cursor, OpenCode, Pi, Google Antigravity,
> GitHub Copilot — install that instead: it adds hooks that enforce frozen rails
> in-session, MCP tools, and prosecutor subagents that this skill cannot provide
> on its own. See https://www.agenticlifecycle.ai/integrations.

## Where am I? → which gate

```
Vague request, no ticket yet? ───────────────→ P0  adlc ticket create
Have a spec / acceptance criteria? ──────────→ P1  adlc spec-lint · premortem · parallax · adversarial-review
Have tickets, planning fan-out? ─────────────→ P2  adlc coldstart · model-router · merge-forecast
About to build, want to freeze tests? ───────→ P3  adlc rails-guard · adversarial-review
Mid-build, agent looping or drifting? ───────→ P4  adlc flail-detector · build-gate
Hard failing test, need a repair? ───────────→ P4  adlc consensus-fix
Change done, pre-merge prosecution? ─────────→ P5  adlc hollow-test · behavior-diff · review-calibration · prosecute · adversarial-review
Recording / showing gate evidence? ──────────→ P6  adlc gate-manifest · adlc accept
Repeated review findings to bank? ───────────→ P7  adlc lesson-foundry · rejection-mining
Idle-time / post-drift maintenance? ─────────→ —   adlc skill-rot · model-ratchet · gate-fuzzing
```

**The adversarial-review loop.** A cross-model, fresh-context ship/no-ship review
that loops review→fix→re-review until clean (`exit 0 = SHIP`). It only reviews a
git diff/branch today (positional args are focus text, not a file path) — it is
recommended practice at **P1** (design review of the ticket/spec) and **P3**
(attack the declared rail *set* for adequacy — is every invariant covered and
unbypassable) via `--prompt-only` or diff review, and at **P5** (built code; ≥2
distinct providers on the risk gate) it runs directly. Flags: `--verify` (refute
stale findings), `--loop` (autonomous fix loop over working-tree code changes
only, needs a write sandbox), `--providers` (multi-provider quorum). Installed
separately — invoke via `npx adversarial-review` if not on PATH. See ADR-0008 in
the ADLC repo.

## The phases

### P0 — Triage (a request becomes a self-contained ticket)
`adlc ticket create --input <path|-> --write` writes through the unified ticket
service. New repositories use one canonical shard per ticket under
`.adlc/tickets/`; legacy `.adlc/tickets.json` remains supported until an
approved migration. Everything downstream reads the logical store.
`adlc ticket list`, `show <id>`, `edit <id>`, `complete <id>`, and `doctor` round
out the surface. **All mutations are dry-run without `--write`.**

### P1 — Interrogate (spec is testable and stress-tested)
- `adlc spec-lint <spec.md>` — every acceptance criterion needs a concrete
  verification method; a "wish" with no method gate-fails (exit 2). Add `--llm`
  (or `--prompt-only`) to also catch vacuous methods.
- `adlc premortem <spec.md> [--prompt-only]` — stress-test the approved spec for
  failure modes before implementation.
- `adlc parallax --request "…"` (or `--file req.md`) — fan out readers to expose
  ambiguity, edge conflicts, or route conflicts. The accuracy dial (D3).
- Design review via `npx adversarial-review --prompt-only` (feed the ticket/spec
  to a model yourself) or `--base <ref>` (review the diff that introduces it).

### P2 — Decompose (an agent can execute without guessing)
- `adlc coldstart <ticket-id> --prompt-only` (or `--all`) — gate ticket
  executability. LLM-backed: use `--prompt-only` and answer the printed audit
  yourself (the bare form needs an API key and exits 1 without one).
- `adlc model-router [--floor <n>]` — assign tickets to frontier/direct/ladder
  model strategies. The cost dial (D1).
- `adlc merge-forecast` — estimate fan-out width, dependency pressure, and merge
  backpressure. The time dial (D2).

### P3 — Rail (frozen paths are protected)
- `adlc rails-guard --base <ref> --ticket <id>` — diff-based check that no
  committed change touched a frozen rail (exit 2 = a rail was edited). This is
  the **unbypassable commit-time backstop**; run it in CI. Wire it with the
  template at `docs/ci/rails-guard.yml` and make it a required check. Override
  deliberately with `ADLC_RAILS_BYPASS=1` (recorded to the manifest).
- **Without a native plugin there is no in-session rail hook.** This skill
  cannot deny an edit to a frozen path while you work — only CI catches it after
  the commit. Before editing, check the active ticket's `rails` yourself with
  `adlc ticket show <id>` and stay out of them.
- Rail-set adequacy review — is every invariant covered and unbypassable — via
  `npx adversarial-review --prompt-only` over the declared rail set + ticket.

### P4 — Build (supervised execution)
- `adlc build-gate <ticket-id>` — deny starting a high-risk ticket build in a
  degraded (context-rot) session unless audited. The ticket id is required.
- `adlc flail-detector <log-file> [--scope <glob>]` — detect repeated errors,
  scope violations, edit churn, oversized logs.
- `adlc consensus-fix --test-cmd "…" --files a.mjs,b.mjs` — for a hard failing
  test, fan out independent candidate repairs and select a gated consensus
  winner. Exploits the generator–verifier gap (E1).

### P5 — Prosecute (the change earns the merge)
- `adlc hollow-test --test-cmd "node --test test/"` — mutate changed code to find
  tests that pass without actually testing the behavior.
- `adlc behavior-diff capture …` / `compare before.json after.json` — make
  behavior change visible for the P6 human gate.
- `adlc review-calibration --review-cmd "… {base} …"` — measure reviewer recall
  by scoring whether review catches injected mutants ("who reviews the reviewer").
- `adlc prosecute --input <passes.json> --ticket <id>` — record ticket- and
  revision-bound P5 prosecution evidence. It is an evidence *recorder*: both
  flags are required, and it does not itself run a review.
- `npx adversarial-review --providers <a,b> [--verify]` — ≥2 distinct providers,
  cross-model and fresh-context, on the risk gate; loop until `exit 0 = SHIP`.
- **Cross-model is GATED (not just advised) for the trust-root tier.** If the
  change touches an enforcement package, a gated-artifact producer, a rails
  deny-path, or a trust-root file, a clean **same-model** P5 is NOT enough: the
  P5 prosecute runner (given `--base <ref>`) exits 2 until the manifest holds a
  `cross-model-review` approve from a provider DISTINCT from the author, bound to
  the reviewed revision. Record it with `record-cross-model`.

### P6 — Integrate (the human gate)
This gate is a human decision, not something an agent passes. Surface the
evidence: `adlc gate-manifest show` and the `behavior-diff compare` output, then
let the human decide. Record outcomes with `adlc gate-manifest record <gate>`,
then `adlc accept --ticket <id> --packet .adlc/packet.json` — both flags are
required, and acceptance also needs complete P5 evidence on the manifest.

### P7 — Distill (turn findings into defenses)
- `adlc lesson-foundry --prompt-only` — mine repeated findings into deterministic
  defenses (lint checks, skills). LLM-backed: answer the printed prompt yourself.
- `adlc rejection-mining --prompt-only` — mine human PR rejections into reusable
  review lenses (needs the `gh` CLI).

P7 has a second axis — mining the *codebase itself* for reusable capabilities:
**skill-mining** (`npx skills add voodootikigod/skill-mining`, then "mine this
repo for skills") surveys churn/conventions/patterns, scores candidates, dedups
against installed skills and the skills.sh registry, and red-teams each authored
`SKILL.md` with a fresh-context agent.

### Maintenance (decay-driven, no human trigger)
- `adlc skill-rot [path…]` — flag skill files with stale validation metadata.
- `adlc model-ratchet --dry-run` — identify hot files to re-prosecute after model
  or repo drift (a plan, not a gate).
- `adlc gate-fuzzing --suite .adlc/gate-suite.json --prompt-only` — play the
  adversary against the gate suite to find calibration gaps.

The deterministic two also run on a cron (`docs/ci/adlc-maintenance.yml`).

## Notes

- Add `--json` to any tool for machine-readable output when orchestrating.
- Writers default to dry-run; pass the documented `--write`/`--record`/`--append`
  flag to actually mutate.
- Run `adlc <tool> --help` for a tool's exact flags and exit-code specifics.
- `adlc fleet` (parallel ticket execution in sandboxed workers) is POSIX-only —
  it is not available on Windows.
