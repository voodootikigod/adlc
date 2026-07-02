---
name: adlc
description: Routes agentic development work to the right Agentic Development Lifecycle (ADLC) gate. Use when shaping a spec or ticket, deciding how to fan out work to models, protecting frozen rails during a build, prosecuting a change before merge, or distilling repeated review findings into defenses. Triggers on "shape this spec", "is this ticket ready", "freeze these tests", "prosecute this change", "is this safe to merge", "ADLC", "which gate", "spec-lint", "premortem", "coldstart", "rails-guard", "hollow-test", "behavior-diff".
---
<!-- ADLC_CC_SENTINEL_PHASE_ROUTER_V1 -->

# ADLC — phase routing

The Agentic Development Lifecycle treats agentic development as phases with
explicit, machine-checkable **gates**. Each gate is a CLI invoked through the
umbrella dispatcher: `adlc <tool> [args]`. Every tool exits `0` = gate passes,
`1` = operational error, `2` = gate fails. Identify the phase, run the gate.

**Claude is the model.** Every LLM-backed gate supports `--prompt-only`: it
prints the exact prompt and exits without calling any provider. Inside Claude
Code you do not need API keys — run the tool with `--prompt-only`, answer the
printed prompt yourself, and apply the judgment. Prefer this over wiring keys.

Prerequisite: the toolkit must be installed (`adlc --version` works). If not,
the user runs `npm i -g @adlc/cli`. Run `/adlc-init` once per repo to create the
`.adlc/` workspace.

## Where am I? → which gate

```
Vague request, no ticket yet? ───────────────→ P0  /adlc-ticket
Have a spec / acceptance criteria? ──────────→ P1  adlc spec-lint · premortem · parallax · adversarial-review
Have tickets, planning fan-out? ─────────────→ P2  adlc coldstart · model-router · merge-forecast
About to build, want to freeze tests? ───────→ P3  adlc rails-guard · adversarial-review
Mid-build, agent looping or drifting? ───────→ P4  adlc flail-detector
Hard failing test, need a repair? ───────────→ P4  adlc consensus-fix
Change done, pre-merge prosecution? ─────────→ P5  adlc hollow-test · behavior-diff · review-calibration · adversarial-review
Recording / showing gate evidence? ──────────→ —   adlc gate-manifest
Repeated review findings to bank? ───────────→ P7  /adlc-distill (lesson-foundry · rejection-mining)
Mine the repo for reusable skills? ──────────→ P7  skill-mining (npx skills add voodootikigod/skill-mining)
Idle-time / post-drift maintenance? ─────────→ —   /adlc-maintain (skill-rot · model-ratchet · gate-fuzzing)
```

**The adversarial-review loop.** A cross-model, fresh-context ship/no-ship review that
loops review→fix→re-review until clean (`exit 0 = SHIP`). It only reviews a git diff/branch
today (positional args are focus text, not a file path) — it is recommended practice at
**P1** (design review of the ticket/spec) and **P3** (attack the declared rail *set* for
adequacy — is every invariant covered and unbypassable) via `--prompt-only` or diff review,
pending the deferred `--input` mode, and at **P5** (built code; ≥2 distinct providers on the
risk gate) it runs directly. Flags: `--verify` (refute stale findings), `--loop` (autonomous
fix loop over working-tree code changes only, needs a write sandbox), `--providers`
(multi-provider quorum). Installed separately — invoke via `npx adversarial-review` if not
on PATH. See ADR-0008 (adversarial-review coverage map) in the ADLC repo.

## The phases

### P0 — Triage → `/adlc-ticket`
Turn a request into a self-contained ticket in `.adlc/tickets.json`. Everything
downstream reads this file; nothing else creates it. Author here first.

### P1 — Interrogate (spec is testable and stress-tested)
- `adlc spec-lint <spec.md>` — every acceptance criterion needs a concrete
  verification method; a "wish" with no method gate-fails (exit 2). Add `--llm`
  (or `--prompt-only`) to also catch vacuous methods.
- `adlc premortem <spec.md> [--prompt-only]` — stress-test the approved spec for
  failure modes before implementation.
- `adlc parallax --request "…"` (or `--file req.md`) — fan out readers to expose
  ambiguity, edge conflicts, or route conflicts. The accuracy dial (D3).
- Design review is recommended practice today via `adversarial-review --prompt-only`
  (feed the ticket/spec to a model yourself) or `adversarial-review --base <ref>`
  (review the diff that introduces it); `exit 0 = SHIP`. First-class artifact input
  (`--input`) is a deferred follow-on — see ADR-0008 (adversarial-review coverage map).

### P2 — Decompose (an agent can execute without guessing)
- `adlc coldstart <ticket-id> --prompt-only` (or `--all`) — gate ticket
  executability. LLM-backed: in Claude, use `--prompt-only` and answer the
  printed audit yourself (the bare form needs an API key and exits 1 without one).
- `adlc model-router [--floor <n>]` — assign tickets to frontier/direct/ladder
  model strategies. The cost dial (D1).
- `adlc merge-forecast` — estimate fan-out width, dependency pressure, and merge
  backpressure. The time dial (D2).

### P3 — Rail (frozen paths are protected)
- `adlc rails-guard --base <ref> --ticket <id>` — diff-based check that no
  committed change touched a frozen rail (exit 2 = a rail was edited). This is the
  **unbypassable commit-time backstop**; run it in CI. The plugin's **PreToolUse
  rail hook** is the in-session layer: it precisely denies Edit/Write/MultiEdit to
  declared rail paths and freezes `.adlc/tickets.json` itself once rails exist.
  **Bash is not gated in-session** — a shell can't be reliably parsed, so rail
  mutations via Bash are caught by the CI diff gate (any spelling), not the hook.
  Wire that gate with the template at `docs/ci/rails-guard.yml` and make it a
  required check. Override deliberately with `ADLC_RAILS_BYPASS=1` (recorded to
  the manifest).
- Rail-set adequacy review — is every invariant covered and unbypassable — is
  recommended practice today via `adversarial-review --prompt-only` (feed the declared
  rail set + ticket + invariants to a model); `exit 0 = SHIP`. `--loop` reviews
  working-tree code changes, not a not-yet-built rail set, so there is no runnable
  `--loop` command at P3 yet. First-class artifact input (`--input`) is a deferred
  follow-on — see ADR-0008 (adversarial-review coverage map).

### P4 — Build (supervised execution)
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
- `adversarial-review --providers <a,b> [--verify]` — ≥2 distinct providers, cross-model
  and fresh-context, on the risk gate; loop review→fix→re-review until `exit 0 = SHIP`.

### P6 — Integrate (the human gate)
This gate is a human decision, not something an agent passes. Surface the
evidence: `adlc gate-manifest show` and the `behavior-diff compare` output, then
let the human decide. Record outcomes with `adlc gate-manifest record <gate>`.

### P7 — Distill (turn findings into defenses) → `/adlc-distill`
- `adlc lesson-foundry --prompt-only` — mine repeated findings into deterministic
  defenses (lint checks, skills). LLM-backed: answer the printed prompt yourself.
- `adlc rejection-mining --prompt-only` — mine human PR rejections into reusable
  review lenses (needs the `gh` CLI). `/adlc-distill` runs both.

P7 has a second, complementary axis — mining the *codebase itself* (not its review
findings) for reusable capabilities:
- **skill-mining** (`npx skills add voodootikigod/skill-mining`, then "mine this
  repo for skills") — surveys git churn/conventions/patterns, scores candidates on
  a five-axis rubric, dedups against installed skills + the `skills.sh` registry,
  red-teams each authored `SKILL.md` with a fresh-context agent (Gate B), and emits
  a `SKILLS_MINED.md` report. It is an agentic skill, not a deterministic `adlc`
  gate (no `--prompt-only`/exit codes). Two uses: (a) standalone, to bootstrap a
  repo's skill portfolio; (b) as the validation/registry step for `SKILL.md` stubs
  that `/adlc-distill`'s lesson-foundry scaffolds — dedup + Gate B before they PR.
  lesson-foundry emits stubs; skill-mining manages the registry.

### Maintenance (decay-driven, no human trigger) → `/adlc-maintain`
- `adlc skill-rot [path…]` — flag skill files with stale validation metadata.
- `adlc model-ratchet --dry-run` — identify hot files to re-prosecute after model
  or repo drift (a plan, not a gate).
- `adlc gate-fuzzing --suite .adlc/gate-suite.json --prompt-only` — play the
  adversary against the gate suite to find calibration gaps (needs a suite file).
- `/adlc-maintain` runs these; the deterministic two also run on a cron
  (`docs/ci/adlc-maintenance.yml`).

## Notes

- Add `--json` to any tool for machine-readable output when orchestrating.
- Writers default to dry-run; pass the documented `--write`/`--record`/`--append`
  flag to actually mutate.
- Run `adlc <tool> --help` for a tool's exact flags and exit-code specifics.
