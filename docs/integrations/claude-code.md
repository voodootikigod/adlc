# Adopt the ADLC in Claude Code

The `@adlc/*` toolkit is a set of gate-shaped CLIs. This plugin makes the whole
**Agentic Development Lifecycle** usable from inside Claude Code: the gates fire
at the right lifecycle moments — some automatically — and the model reaches for
the right gate without you memorizing 20 tools.

> Design and rationale: [ADR 0003 — Bringing the ADLC to Claude Code as a plugin](../adr/0003-adlc-claude-code-plugin.md).
> The full thesis: [`../../ADLC.md`](../../ADLC.md).

## Install

```sh
npm install -g @adlc/cli                     # the toolkit, behind one `adlc <tool>` command
/plugin marketplace add voodootikigod/adlc   # register this repo as a marketplace
/plugin install adlc@adlc                     # install the plugin
/adlc-init                                    # bootstrap .adlc/ in your repo (once)
```

Local install verification:

```sh
node scripts/claude-code-plugin-smoke.mjs .
```

That smoke test validates the plugin manifest, marketplace entry, hook
registrations (all four event types), hook zero-dependency guarantee, command
files, prosecutor subagent, and skill sentinel. It does not exercise the rail
hook or interact with Claude Code.

**No API keys.** Every LLM-backed gate supports `--prompt-only`: inside Claude
Code, *Claude is the model* — the gate prints its prompt, Claude answers it, and
the judgment is applied. The only prerequisite is `adlc` on your PATH (the npm
install above) and Node 18+.

## What you get

### Commands

| Command | Phase | What it does |
| --- | --- | --- |
| `/adlc-init` | — | Bootstrap `.adlc/`, split the committable ticket contract from runtime evidence in `.gitignore`, run preflight. |
| `/adlc-ticket` | P0 | Author a self-contained, schema-valid ticket (the contract every gate reads), then check it is executable. Ticket schema: [`docs/ticket-authoring.md`](../ticket-authoring.md). |
| `/adlc-distill` | P7 | Mine repeated findings and PR rejections into deterministic defenses (lint rules, skills, review lenses). |
| `/adlc-maintain` | C10/C12 | Decay-driven checks: stale skills, hot files to re-prosecute, gate calibration. |

### The discovery skill

The `adlc` skill is a phase-routing flowchart: describe what you're doing ("shape
this spec", "is this safe to merge") and it routes you to the right gate. It is
how the model embraces the lifecycle in total.

### The prosecutor subagent

`prosecutor` is a hostile pre-merge (P5) reviewer: it runs `hollow-test` (are the
tests load-bearing?), `behavior-diff` (is the behavior change visible?), and
`review-calibration` (would the review catch a planted defect?) and returns an
evidence-backed verdict.

### Hooks (automatic)

| Hook | Event | Behavior |
| --- | --- | --- |
| preflight | SessionStart | Advisory: warns if the environment isn't ready for fan-out. |
| flail-detection | PostToolUse | Advisory: flags repeated-error / churn loops over a bounded recent window of the transcript. |
| gate-manifest audit | Stop | Advisory: warns only if the gate-evidence chain is broken. |
| **rails-guard** | PreToolUse | **Enforcing**: denies structured edits (Edit/Write/MultiEdit) to frozen rail paths declared in tickets. Bash is not gated in-session (a shell can't be reliably parsed); Bash rail mutations are caught by the CI diff gate at commit time. |

All hooks no-op unless the repo is ADLC-initialized. Rail enforcement
additionally no-ops until a ticket declares `rails`, so installing the plugin
into a repo with no rails can never block editing.

**Rails must be tracked files.** The commit-time CI gate inspects the git diff,
so it only protects files under version control. A gitignored/untracked rail
mutated via Bash is seen by neither the in-session hook (Bash isn't gated) nor
the CI diff gate. Declare rails on tracked files (tests, type contracts, configs)
— which is their normal use.

**Rail bypass — two distinct layers.** `ADLC_RAILS_BYPASS=1` overrides the
*in-session* PreToolUse hook only, and only if the override is recorded to the
gate-manifest (an un-auditable bypass is refused). The *commit-time* CI gate is
deliberately **not** env-bypassable — that is the whole point of an unbypassable
backstop. A legitimately needed rail change (e.g. updating a frozen test once its
ticket is complete) is therefore a privileged, human action: a maintainer
overrides the required `rails-guard` check (admin merge) — which is the correct
posture, since changing a frozen rail is exactly the kind of decision that should
require a human, not an environment variable. Once any rail is declared,
`.adlc/tickets.json` itself is frozen so the rail set can't be quietly edited away.

## CI backstops (recommended)

The in-session rail hook is best-effort for Bash; pair it with the commit-time
gate so obfuscated shell writes are still caught. Copy these into
`.github/workflows/`:

- [`ci/rails-guard.yml`](../ci/rails-guard.yml) — rejects a PR whose diff touches a
  frozen rail. Make it a required check. The rail set is read from the **base**
  ref, so a PR can't remove rails to disable the gate.
- [`ci/adlc-maintenance.yml`](../ci/adlc-maintenance.yml) — a weekly advisory cron
  running the deterministic maintenance checks into the job summary.

Both templates pin `@adlc/cli` and their actions to exact versions/SHAs; bump
deliberately after reviewing a release.

## Lifecycle coverage

| Phase | Coverage | Wired via |
| --- | --- | --- |
| P0 Triage | Strong | `/adlc-ticket` |
| P1 Interrogate | Strong | `spec-lint`, `premortem`, `parallax` (via the `adlc` skill) |
| P2 Decompose | Strong | `coldstart`, `model-router`, `merge-forecast` |
| P3 Rail | Strong | rails-guard PreToolUse hook + CI backstop |
| P4 Build | Strong | flail-detection hook, `consensus-fix` |
| P5 Prosecute | Partial | `prosecutor` subagent runs the gates; formal phase assertion (`adlc run p5`) is not available on the CC path — see Gaps below. |
| P6 Integrate | Conditional | gate-manifest evidence surfaced for the human gate; strong when backed by valid P5 evidence. |
| P7 Distill | Strong | `/adlc-distill` |
| Maintenance | Strong | `/adlc-maintain` + CI cron |

P6 is a human decision by design; the plugin surfaces the evidence, it does not
automate the judgment.

After a prosecution that returns CLEAR, record informal evidence with
`adlc gate-manifest record prosecution --files <changed files>`. This entry is
useful for provenance auditing but does **not** satisfy `adlc run p5` — see the
Gaps section below for the full explanation and the Codex path for formal phase
assertion.

## Using with Codex

The Claude Code plugin and the Codex plugin are designed to coexist. A common
setup uses Claude Code for interactive sessions (commands, hooks, skill routing)
and Codex for CI workers (skill invocations, phase-assertion hooks). Both write
to the same `.adlc/` workspace and read the same tickets.

Command separation is by design (ADR 0002):
- `adlc <tool>` — gate dispatcher; routes tool invocations and, via reserved
  verbs, phase-assertion commands (`adlc run <phase>`, `adlc accept`).
- `adlc-runner` — the underlying runner binary (`@adlc/runner`); invoked by
  the dispatcher, not called directly in normal workflows.

Formal phase assertions (`adlc run p5`, `adlc accept`) are part of the Codex
surface. See [`codex.md`](./codex.md) and
[ADR 0002](../adr/0002-adlc-command-reconciliation.md) for the full command
reconciliation rationale.

## Gaps

Current gaps relative to the formal ADLC doctrine:

1. **P5 formal assertion is not available on the CC path.** The `prosecutor`
   subagent runs `hollow-test`, `behavior-diff`, and `review-calibration` and
   returns an evidence-backed verdict. After a CLEAR verdict, `adlc gate-manifest
   record prosecution` records provenance evidence — but this entry carries
   `gate: "prosecution"`, which does not satisfy `adlc run p5`. The runner
   requires `type: "p5-complete"` plus provenance, transcript hashes, and a
   completed dry-pass convergence chain that the `gate-manifest` command does not
   produce. Formal P5 phase assertion requires the Codex path
   (`adlc prosecute` → `adlc run p5`). There is no example fixture for the CC
   path comparable to `docs/examples/p5-passes.json`; the Codex fixture is the
   authoritative reference.
2. **In-session Bash rail enforcement is absent (intentional).** A shell is
   Turing-complete and cannot be reliably parsed for mutation targets; every
   parser attempted had further bypasses. Rail mutations via Bash are caught at
   commit time by the unbypassable `rails-guard` CI diff gate. See
   [ADR 0003](../adr/0003-adlc-claude-code-plugin.md) for the full rationale.
3. **Skill discovery depends on description matching.** The `adlc` phase router
   is one skill with a broad trigger set, but a poorly-phrased request may not
   match the description and will not route through the lifecycle.

## Boundary

- `.adlc/` is the runtime state area for tickets, manifests, and gate evidence.
- `.omo/` is for operator planning artifacts (Codex-specific; CC planning files
  currently live under `docs/` by convention).
- The docs in this directory are the high-level map; package READMEs are the
  source of truth for exact flags, schemas, and exit codes.
