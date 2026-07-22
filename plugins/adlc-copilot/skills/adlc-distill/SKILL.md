---
name: adlc-distill
description: Run ADLC P7 distillation in the GitHub Copilot CLI — lesson-foundry, rejection-mining, and review-calibration — turning repeated review findings and PR rejections into permanent, deterministic defenses. Decay-driven maintenance lives in the adlc-maintain skill.
---

<!-- ADLC_COPILOT_SENTINEL_DISTILL_V1 -->

# ADLC Distill

P7 is where the lifecycle compounds: repeated findings become deterministic
defenses (lint checks, skills, spec-gap templates) so the same mistake cannot
recur. This is idle-time work — run it after a batch of reviews, or on a schedule.

Both gates here are LLM-backed, and inside the GitHub Copilot CLI **you are the
model** — use `--prompt-only`, answer the printed prompt yourself, and apply the
result. No API keys. Prerequisite: `adlc --version` works (else `npm i -g @adlc/cli`).

## Distillation

```sh
adlc lesson-foundry --prompt-only
adlc rejection-mining --prompt-only
adlc review-calibration --review-cmd "npx adversarial-review --base {base}" --json
```

- `lesson-foundry` mines repeated findings in `.adlc/findings.jsonl` into
  deterministic defenses. If it prints `(no clusters to refine)`, there are not yet
  enough repeated findings to distill — report that and stop. Otherwise answer each
  cluster's prompt yourself, deciding the cheapest deterministic defense (a lint
  rule, a skill, or a spec-gap template) that would have caught the whole cluster.
  After the user approves, scaffold with `adlc lesson-foundry --write --out-dir
  .adlc/lessons` (the writer is dry-run by default), then edit the scaffolded files
  to match the wording you decided — `--write` alone does not apply your prompt-only
  refinement.
- For any defense that is a *skill* (a `SKILL.md`), validate it before PR: hand the
  scaffolded stub to **skill-mining** (`npx skills add voodootikigod/skill-mining`)
  for dedup against the public ecosystem and a Gate B red-team. Only PR a SHIP-verdict
  skill; hold un-validated stubs for human review rather than landing them.
- `rejection-mining` reads recent PR review rejections via the `gh` CLI and turns
  each repeated human objection into a reusable review lens. If it errors with a
  `gh`/auth/repo message, the repo is not GitHub-linked or `gh` is not authenticated
  — note that this gate was skipped and why, then continue. Materialize with `--write`
  only after approval.
- Record a no-op manifest entry when there is nothing to distill so the runner can
  distinguish "checked and empty" from "skipped."

## Summarize

Report how many finding clusters and rejection lenses were found, the concrete
defenses proposed, which were written (if any), and which gates were skipped (e.g.
rejection-mining when `gh` is unavailable) so the coverage stays honest. For any
*skill* defense, report its skill-mining verdict or flag it as held for human review.
Point the user at `/adlc-maintain` for the decay-driven maintenance checks (skill-rot,
model-ratchet, ticket-prune, gate-fuzzing).

## Scheduling

This skill is idle-time metabolism. **Headless runs are advisory by default:** the
write steps above require human approval, so an unattended scheduled Copilot session
will *propose* defenses in its summary without materializing them — auto-writing lint
rules or skills from clustered findings unattended is risky. The skill-mining handoff
is likewise interactive only; a headless run must never `npx skills add` or
auto-validate skills.
