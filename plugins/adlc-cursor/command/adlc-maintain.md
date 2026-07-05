---
description: Run the decay-driven ADLC maintenance checks — stale skills, hot files to re-prosecute, stale tickets, and gate calibration (C10/C12).
---

# /adlc-maintain — fight decay (C10 / C12 + calibration)

Some assumptions rot over time or after a model/repo change: skill cache
metadata goes stale, files churn enough to deserve re-prosecution, shipped
tickets linger in the contract, and gates that once held may now be defeatable.
This command runs those checks. It is idle-time work — run it on a schedule or
after a model upgrade.

Prerequisite: `adlc --version` works (else `npm i -g @adlc/cli`). Report a single
honest summary at the end, including any check that did not apply.

## 1. Skill rot — stale validation metadata (C10)
Run `adlc skill-rot <skill-dir-or-glob> --json`.
- Exit `0`: skills are fresh.
- Exit `2`: stale validation metadata — list the skills and recommend
  re-validating (then `--write` to stamp freshness once re-checked).
- Exit `1` with `nothing to verify`: informational, not a failure. Note it.

## 2. Model ratchet — hot files to re-prosecute (C12)
Run `adlc model-ratchet --dry-run --json`.
- Lists the highest-churn / highest-dependency files (`score`) — the best
  candidates to re-prosecute after model or repo drift. This is a *plan*, not a
  gate. Report the top files and suggest running `/adlc-prosecute` (or
  `npx adversarial-review`) against them.
- With a `--review-cmd`, model-ratchet can run a review over those files and
  append findings to `.adlc/findings.jsonl` (which later feeds `/adlc-distill`).

## 3. Ticket prune — stale ticket hygiene
Run `adlc ticket-prune --json`.
- Dry-run by default (this call never writes): reports tickets that look
  already shipped — an explicit done-shaped status, or every declared `scope`
  glob resolving to a file already tracked on `HEAD`. Exit `0` either way;
  exit `1` only on an operational error.
- List the stale tickets and recommend confirming them by hand, then re-running
  with `adlc ticket-prune --write` to archive them into the gitignored
  `.adlc/tickets.archive.json` (never deletes outright). Treat `--write` as a
  human-confirmed action — `.adlc/tickets.json` is the shared rail trust root,
  and the commit-time CI gate (`scripts/rails-guard-ci.mjs`) hard-denies
  removing a base-ref ticket in a PR, so a prune of already-merged tickets
  can only land through the protected-base ceremony, not a normal PR (known
  constraint: voodootikigod/adlc#104).

## 4. Gate fuzzing — can hostile candidates defeat the gates? (calibration)
Only if a gate suite exists at `.adlc/gate-suite.json` (without one the tool
exits `1` — note that calibration was skipped):
`adlc gate-fuzzing --suite .adlc/gate-suite.json --prompt-only`.
LLM-backed: inside Cursor, use `--prompt-only` and play the adversary yourself
against each gate. A gate you can defeat is a **calibration gap** — report it.

## Summarize
Report: stale skills (if any), the top hot files to re-prosecute, stale tickets
found (and whether they were archived), gate-fuzzing result or why it was
skipped, and recommended next actions. Repeated findings surfaced here flow into
`/adlc-distill`.
