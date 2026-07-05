---
description: Run the decay-driven ADLC maintenance checks — stale skills, hot files to re-prosecute, stale tickets, and gate calibration (C10/C12).
argument-hint: (no arguments)
---

# /adlc:adlc-maintain — fight decay (C10 / C12 + calibration)

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
  `prosecutor` subagent against them (there is no standalone prosecute command
  in this plugin — invoke the subagent directly).
- With a `--review-cmd`, model-ratchet can run a review over those files and
  append findings to `.adlc/findings.jsonl` (which later feeds `/adlc:adlc-distill`).

## 3. Ticket prune — stale ticket hygiene

```
adlc ticket-prune --json
```

- Dry-run by default (this call never writes): reports tickets that look
  already shipped — either an explicit `status: done`-shaped field, or every
  declared `scope` glob resolving to a file already tracked on `HEAD`. This is
  a *plan*, not a gate — it does not fail on stale tickets (exit `0` either
  way; exit `1` only on an operational error such as a missing/invalid
  `.adlc/tickets.json`).
- List the stale tickets it finds and recommend confirming them by hand, then
  re-running with `adlc ticket-prune --write` to archive them into the
  gitignored `.adlc/tickets.archive.json` (never deletes outright). Treat
  `--write` as a human-confirmed action, not something this command should
  run unattended — `.adlc/tickets.json` is a shared, hand-edited file.

## 4. Gate fuzzing — can hostile candidates defeat the gates? (calibration)

Only run this if a gate suite exists at `.adlc/gate-suite.json`; without one the
tool exits `1` (`Gate suite not found`) — note that calibration was skipped.

```
adlc gate-fuzzing --suite .adlc/gate-suite.json --prompt-only
```

- LLM-backed: in Claude, use `--prompt-only` and play the adversary yourself
  against each gate in the suite. A gate you can defeat is a **calibration gap** —
  report it; the gate needs strengthening (this is the gate-fuzzing exit-`2`
  condition when run with a provider).

## 5. Summarize

Report: stale skills (if any), the top hot files to re-prosecute, any stale
tickets found (and whether they were archived), gate-fuzzing result or why it
was skipped, and the recommended next actions. Repeated findings surfaced here
flow into `/adlc:adlc-distill`.

## Scheduling

The deterministic checks here (`skill-rot`, `model-ratchet`, `ticket-prune`) are
keyless and run well on a cron — see the ready-to-use workflow at
`docs/ci/adlc-maintenance.yml`.
The LLM-backed gate-fuzzing runs via a scheduled Claude routine (`/schedule`
invoking `/adlc:adlc-maintain`), where Claude is the model and no API keys are needed.
