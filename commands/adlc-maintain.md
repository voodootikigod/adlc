---
description: Run the decay-driven ADLC maintenance checks — stale skills, hot files to re-prosecute, and gate calibration (C10/C12).
argument-hint: (no arguments)
---

# /adlc-maintain — fight decay (C10 / C12 + calibration)

Some assumptions rot over time or after a model/repo change: skill cache
metadata goes stale, files churn enough to deserve re-prosecution, and gates that
once held may now be defeatable. This command runs those checks. It is idle-time
work — run it on a schedule or after a model upgrade.

Prerequisite: `adlc --version` works (else `npm i -g @adlc/cli`). Report a single
honest summary at the end, including any check that did not apply.

## 1. Skill rot — stale validation metadata (C10)

```
adlc skill-rot <skill-dir-or-glob> --json
```

- Exit `0`: skills are fresh.
- Exit `2`: one or more skills have stale validation metadata — list them and
  recommend re-validating (and `--write` to stamp freshness once re-checked).
- Exit `1` with `nothing to verify`: the targeted skills carry no validation
  metadata to check — this is informational, not a failure. Note it.

## 2. Model ratchet — hot files to re-prosecute (C12)

```
adlc model-ratchet --dry-run --json
```

- Lists the highest-churn / highest-dependency files (`score`), which are the
  best candidates to re-prosecute after model or repo drift. This is a *plan*,
  not a gate — it does not fail. Report the top files and suggest running the
  prosecutor (`/adlc-prosecute` or the `prosecutor` subagent) against them.
- With a `--review-cmd`, model-ratchet can run a review over those files and
  append findings to `.adlc/findings.jsonl` (which later feeds `/adlc-distill`).

## 3. Gate fuzzing — can hostile candidates defeat the gates? (calibration)

Only run this if a gate suite exists at `.adlc/gate-suite.json`; without one the
tool exits `1` (`Gate suite not found`) — note that calibration was skipped.

```
adlc gate-fuzzing --suite .adlc/gate-suite.json --prompt-only
```

- LLM-backed: in Claude, use `--prompt-only` and play the adversary yourself
  against each gate in the suite. A gate you can defeat is a **calibration gap** —
  report it; the gate needs strengthening (this is the gate-fuzzing exit-`2`
  condition when run with a provider).

## 4. Summarize

Report: stale skills (if any), the top hot files to re-prosecute, gate-fuzzing
result or why it was skipped, and the recommended next actions. Repeated findings
surfaced here flow into `/adlc-distill`.

## Scheduling

The deterministic checks here (`skill-rot`, `model-ratchet`) are keyless and run
well on a cron — see the ready-to-use workflow at `docs/ci/adlc-maintenance.yml`.
The LLM-backed gate-fuzzing runs via a scheduled Claude routine (`/schedule`
invoking `/adlc-maintain`), where Claude is the model and no API keys are needed.
