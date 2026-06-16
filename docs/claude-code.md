# Adopt the ADLC in Claude Code

The `@adlc/*` toolkit is a set of gate-shaped CLIs. This plugin makes the whole
**Agentic Development Lifecycle** usable from inside Claude Code: the gates fire
at the right lifecycle moments — some automatically — and the model reaches for
the right gate without you memorizing 20 tools.

> Design and rationale: [`claude-code-integration-plan.md`](./claude-code-integration-plan.md).
> The full thesis: [`../ADLC.md`](../ADLC.md).

## Install

```sh
npm install -g @adlc/cli                     # the toolkit, behind one `adlc <tool>` command
/plugin marketplace add voodootikigod/adlc   # register this repo as a marketplace
/plugin install adlc@adlc                     # install the plugin
/adlc-init                                    # bootstrap .adlc/ in your repo (once)
```

**No API keys.** Every LLM-backed gate supports `--prompt-only`: inside Claude
Code, *Claude is the model* — the gate prints its prompt, Claude answers it, and
the judgment is applied. The only prerequisite is `adlc` on your PATH (the npm
install above) and Node 18+.

## What you get

### Commands

| Command | Phase | What it does |
| --- | --- | --- |
| `/adlc-init` | — | Bootstrap `.adlc/`, split the committable ticket contract from runtime evidence in `.gitignore`, run preflight. |
| `/adlc-ticket` | P0 | Author a self-contained, schema-valid ticket (the contract every gate reads), then check it is executable. |
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
| **rails-guard** | PreToolUse | **Enforcing**: denies edits (Edit/Write/MultiEdit and best-effort Bash writes) to frozen rail paths declared in tickets. |

All hooks no-op unless the repo is ADLC-initialized. Rail enforcement
additionally no-ops until a ticket declares `rails`, so installing the plugin
into a repo with no rails can never block editing.

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

- [`ci/rails-guard.yml`](./ci/rails-guard.yml) — rejects a PR whose diff touches a
  frozen rail. Make it a required check. The rail set is read from the **base**
  ref, so a PR can't remove rails to disable the gate.
- [`ci/adlc-maintenance.yml`](./ci/adlc-maintenance.yml) — a weekly advisory cron
  running the deterministic maintenance checks into the job summary.

Both templates pin `@adlc/cli` and their actions to exact versions/SHAs; bump
deliberately after reviewing a release.

## Lifecycle coverage

| Phase | Wired via |
| --- | --- |
| P0 Triage | `/adlc-ticket` |
| P1 Interrogate | `spec-lint`, `premortem`, `parallax` (via the `adlc` skill) |
| P2 Decompose | `coldstart`, `model-router`, `merge-forecast` |
| P3 Rail | rails-guard PreToolUse hook + CI backstop |
| P4 Build | flail-detection hook, `consensus-fix` |
| P5 Prosecute | `prosecutor` subagent |
| P6 Integrate | gate-manifest evidence surfaced for the human gate |
| P7 Distill | `/adlc-distill` |
| Maintenance | `/adlc-maintain` + CI cron |

P6 is a human decision by design; the plugin surfaces the evidence, it does not
automate the judgment.
