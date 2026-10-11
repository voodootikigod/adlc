---
description: Distill repeated review findings and PR rejections into permanent, deterministic defenses (P7).
argument-hint: "[scope]"
---

# /adlc-distill — turn findings into defenses (P7)

P7 is where the lifecycle compounds: repeated findings become deterministic
defenses (lint checks, skills, spec-gap templates, review lenses) so the same
class of defect can't recur. This is idle-time work — run it after a batch of
reviews. Target scope: `$ARGUMENTS` (default to recent history). See the
`adlc-distill` skill for the command reference.

These LLM-backed gates run against your configured provider (`--json`); add
`--prompt-only` to answer the printed prompt yourself (keyless — you are the
working model). Prerequisite: `adlc --version` works (else `npm i -g @adlc/cli`).

## 1. Lesson foundry — mine repeated findings (C9)
Run `adlc lesson-foundry --json` (or `--prompt-only`).
- `(no clusters to refine)` → not enough repeated findings in
  `.adlc/findings.jsonl` yet; report that and stop here.
- Otherwise, decide the cheapest *deterministic* defense that would have caught
  the whole cluster — a lint rule, a skill, or a spec-gap template — preferring a
  machine-checkable gate over a prose reminder.
- After the user approves, materialize with
  `adlc lesson-foundry --write --out-dir .adlc/lessons` (dry-run by default),
  then edit the scaffolded files to match the defenses you decided — `--write`
  alone does not apply your refinement.

## 2. Rejection mining — mine human PR objections (C13)
Run `adlc rejection-mining --json` first (deterministic, keyless: it fetches
recent PR review rejections via the `gh` CLI and clusters them). If it errors
with a `gh`/auth/repo message, note that this gate was skipped and why, then
continue. `--prompt-only` mines the same real rejections through `gh` and prints one
refinement prompt per cluster (nothing on stdout, plus a stderr note, when there
are no clusters), so either flag is safe for the fetch: prefer `--json` for the
deterministic record and `--prompt-only` for the lens-writing prompts.
- Turn each repeated human objection into a reusable **review lens** (a question
  a future prosecutor should ask). Materialize with `--write` only after
  approval.

## 3. Check skill decay
Run `adlc skill-rot --json` (deterministic — it scans skill files' validation
metadata; no LLM/`--prompt-only` mode) and flag any skills with stale validation
metadata for re-validation.

## Close the loop — the lesson-foundry gate must be green

Distillation is done only when no recurring finding cluster is left undefended.
After writing and refining the lessons above (only *materialized* lessons count),
run the gate as the closing check:

```
adlc lesson-foundry --gate
```

It must exit `0`. A non-zero exit names each cluster in `.adlc/findings.jsonl`
that recurs but still has no banked lesson — write or refine its lesson and re-run
until the gate is green. In an advisory or headless run where nothing was
materialized, expect the gate to stay red: report the named unbanked clusters as
the outstanding P7 work rather than treating red as complete.

## Summarize
Report: the finding clusters and rejection lenses found, the concrete defenses
proposed, which were written (if any), and which gates were skipped (e.g.
rejection-mining without `gh`) so the coverage stays honest. Point the user at
`/adlc-maintain` for the decay-driven checks.
