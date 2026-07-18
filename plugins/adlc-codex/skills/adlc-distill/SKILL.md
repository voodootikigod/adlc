---
name: adlc-distill
description: Run ADLC P7 distillation and maintenance workflows in Codex, including lesson-foundry, rejection-mining, skill-mining, scheduled maintenance, skill-rot, model-ratchet, review-calibration, and gate-fuzzing.
---

ADLC_CODEX_SENTINEL_DISTILL_V1

# ADLC Distill

P7 converts repeated findings into deterministic defenses and keeps cached guidance fresh.

## Distillation

```sh
adlc lesson-foundry --json
adlc rejection-mining --json
adlc review-calibration --review-cmd "npx adversarial-review --base {base}" --json
```

`lesson-foundry` is LLM-backed — use `--prompt-only` and answer the printed
prompt yourself, mining repeated findings into deterministic defenses (lint
checks, skills). `rejection-mining` mines human PR rejections into reusable
review lenses (needs the `gh` CLI). Record a no-op manifest entry when there
is nothing to distill so the runner can distinguish "checked and empty" from
"skipped."

## Maintenance (decay-driven, idle-time work — C10/C12 + calibration)

Assumptions rot over time or after a model/repo change: skill cache metadata
goes stale, files churn enough to deserve re-prosecution, and gates that once
held may now be defeatable. Run these on a schedule or after a model upgrade,
and report a single honest summary including any check that did not apply.

### 1. Skill rot — stale validation metadata (C10)

```sh
adlc skill-rot .agents/skills plugins/adlc-codex/skills --json
```

- Exit `0`: skills are fresh.
- Exit `2`: one or more skills have stale validation metadata — list them and
  recommend re-validating (`--write` to stamp freshness once re-checked).
- Exit `1` with `nothing to verify`: the targeted skills carry no validation
  metadata to check — informational, not a failure.

### 2. Model ratchet — hot files to re-prosecute (C12)

```sh
adlc model-ratchet --dry-run --json
```

Lists the highest-churn / highest-dependency files, the best candidates to
re-prosecute after model or repo drift. This is a **plan, not a gate** — it
never fails. Report the top files and suggest running the multi-lens
prosecution fan-out (`$adlc-prosecute`) against them. With `--review-cmd`,
`model-ratchet` can run a review over those files and append findings to
`.adlc/findings.jsonl` (which later feeds `$adlc-distill`'s lesson-foundry).

### 3. Ticket prune — stale ticket hygiene

```sh
adlc ticket-prune --json
```

Dry-run by default (never writes on its own): reports tickets that look
already shipped — an explicit `status: done`-shaped field, or every declared
`scope` glob already resolving to a file tracked on `HEAD`. A **plan, not a
gate** — exit `0` either way; exit `1` only on an operational error (a
missing/invalid ticket store). List stale tickets found and recommend
confirming by hand, then `adlc ticket-prune --write` to archive into the
gitignored `.adlc/tickets.archive.json` (never deletes outright). Treat
`--write` as a human-confirmed action — the ticket store is shared,
hand-edited state.

### 4. Gate fuzzing — can hostile candidates defeat the gates? (calibration)

Only run if a gate suite exists at `.adlc/gate-suite.json`; without one the
tool exits `1` (`Gate suite not found`) — note that calibration was skipped.

```sh
adlc gate-fuzzing --suite .adlc/gate-suite.json --prompt-only
```

LLM-backed: use `--prompt-only` and play the adversary yourself against each
gate in the suite. A gate you can defeat is a **calibration gap** — report
it; the gate needs strengthening (the gate-fuzzing exit-`2` condition when
run with a real provider).

### Scheduling

The deterministic checks (`skill-rot`, `model-ratchet`, `ticket-prune`) are
keyless and run well on a cron — see `docs/ci/adlc-maintenance.yml`. The
LLM-backed `gate-fuzzing` check runs via a scheduled Codex session invoking
this skill, where Codex is the model and no API keys are needed — CI cron is
the deterministic fallback for the other three when no scheduled session is
configured.
