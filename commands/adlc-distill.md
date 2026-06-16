---
description: Distill repeated review findings and PR rejections into permanent, deterministic defenses (ADLC P7).
argument-hint: (no arguments)
---

# /adlc-distill — compound the lifecycle (P7)

P7 is where the lifecycle compounds: repeated findings become deterministic
defenses (lint checks, skills, spec-gap templates) so the same mistake cannot
recur. This is idle-time work — run it after a batch of reviews, or on a schedule
(see "Scheduling" below).

Both gates here are LLM-backed, and inside Claude Code **you are the model** —
use `--prompt-only`, answer the printed prompt yourself, and apply the result.
No API keys. Prerequisite: `adlc --version` works (else `npm i -g @adlc/cli`).

## 1. Lesson foundry — mine repeated findings (C9)

```
adlc lesson-foundry --prompt-only
```

- If it prints `(no clusters to refine)`, there are not yet enough repeated
  findings in `.adlc/findings.jsonl` to distill — report that and stop here.
- Otherwise it prints one prompt per cluster of repeated findings. For each,
  **answer the prompt yourself**: decide the cheapest *deterministic* defense that
  would have caught the whole cluster — a lint rule, a skill, or a spec-gap
  template — preferring a machine-checkable gate over a prose reminder.
- Present the proposed defenses. After the user approves, materialize them:
  1. Run `adlc lesson-foundry --write --out-dir .adlc/lessons` (the writer is
     dry-run by default, so nothing is created without `--write`). This scaffolds
     one defense file per cluster from the finding data, with **default wording**.
  2. **Then edit the scaffolded files** to match the defenses you decided above.
     `--write` on its own does NOT apply your prompt-only refinement — that is
     only auto-applied with `--llm` (which needs an API key). So in the keyless
     in-Claude flow you scaffold with `--write`, then refine the wording yourself.

## 2. Rejection mining — mine human PR objections (C13)

```
adlc rejection-mining --prompt-only
```

- This reads recent PR review rejections via the `gh` CLI. If it errors with a
  `gh`/auth/repo message, the repo is not GitHub-linked or `gh` is not
  authenticated — note that this gate was skipped and why, then continue.
- Otherwise answer the printed prompt(s): turn each repeated human objection into
  a reusable **review lens** (a question a future prosecutor should ask). Present
  the lenses; materialize with `--write` only after approval.

## 3. Summarize

Report: how many finding clusters and rejection lenses were found, the concrete
defenses proposed, which were written (if any), and which gates were skipped
(e.g. rejection-mining when `gh` is unavailable) so the coverage is honest. Point
the user at `/adlc-maintain` for the decay-driven checks.

## Scheduling

This command is idle-time metabolism. To run it automatically, schedule a Claude
routine (e.g. via `/schedule`) that invokes `/adlc-distill` on a cadence — Claude
is the model, so no API keys are needed.

**Headless runs are advisory by default.** The write steps above require human
approval, so an unattended scheduled run will *propose* defenses (in its summary)
without materializing them — that is intentional: auto-writing lint rules/skills
from clustered findings unattended is risky. A scheduled routine should surface
the proposals for a human to review and then approve `--write`. Only wire an
auto-`--write` routine if you have explicitly accepted that the generated
defenses land without review. The deterministic maintenance checks
(`/adlc-maintain`) can additionally run in CI on a cron; see
`docs/ci/adlc-maintenance.yml`.
