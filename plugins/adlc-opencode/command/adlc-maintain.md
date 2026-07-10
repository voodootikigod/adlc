---
description: Run the decay-driven ADLC maintenance checks — stale skills, hot files to re-prosecute, stale tickets (C10/C12). Gate-fuzzing is CI-only.
---

# /adlc-maintain — fight decay (C10 / C12 + calibration)

Some assumptions rot over time or after a model/repo change: skill cache metadata
goes stale, files churn enough to deserve re-prosecution, and tickets get left
behind after their work merges. This command runs those deterministic checks. It
is idle-time work — run it on a schedule or after a model upgrade.

Prerequisite: `adlc --version` works (else `npm i -g @adlc/cli`). Report a single
honest summary at the end, including any check that did not apply.

## 1. Skill rot — stale validation metadata (C10)

Run over the native skill deployment and the packaged sources:

```
adlc skill-rot .opencode/skills --json
```

- Exit `0`: skills are fresh.
- Exit `2`: one or more skills have stale validation metadata — list them and
  recommend re-validating (then `--write` to stamp freshness once re-checked).
- Exit `1` with `nothing to verify`: the targeted skills carry no validation
  metadata — informational, not a failure. Note it.

## 2. Model ratchet — hot files to re-prosecute (C12)

```
adlc model-ratchet --dry-run --json
```

- Lists the highest-churn / highest-dependency files (`score`) — the best
  candidates to re-prosecute after model or repo drift. This is a *plan*, not a
  gate; it does not fail. Report the top files and recommend running the native
  **`adlc_prosecute`** tool (or `/adlc-prosecute`) against them.
- With a `--review-cmd`, model-ratchet can review those files and append findings
  to `.adlc/findings.jsonl` (which later feeds `/adlc-distill`). Under frozen
  rails the in-session guard denies `--review-cmd` via `adlc_gate` — run that
  variant through the `adlc` CLI, where the CI diff gate is the backstop.

## 3. Ticket prune — stale ticket hygiene

```
adlc ticket-prune --json
```

- Dry-run by default (this call never writes): reports tickets that look already
  shipped — an explicit `status: done`-shaped field, or every declared `scope`
  glob resolving to a file already tracked on `HEAD`. A *plan*, not a gate (exit
  `0` either way; exit `1` only on an operational error such as a
  missing/invalid `.adlc/tickets.json`).
- List the stale tickets and recommend confirming them by hand, then re-running
  `adlc ticket-prune --write` to archive them into the gitignored
  `.adlc/tickets.archive.json` (never deletes outright). Treat `--write` as a
  human-confirmed action — `.adlc/tickets.json` is a shared, hand-edited file
  and the rail trust root.

## 4. Gate fuzzing — NOT run automatically (needs a model AND a sandbox)

`adlc gate-fuzzing` is doubly constrained: it is **LLM-backed** (an adversary
model generates the candidates) *and* it executes untrusted adversary code that
**requires an OS-level sandbox** (`bwrap` / `sandbox-exec`; the CLI refuses to run
on a bare developer host). Because of the first constraint the deterministic
maintenance cron (`docs/ci/adlc-maintenance.yml`) does **not** run it, and because
of the second this command does **not** run it either — an interactive OpenCode
session on a developer machine is the wrong place.

So calibration runs **nowhere automatically** in what this integration ships. To
actually exercise gate defeats after model/repo drift you must set up a
**separate scheduled job that provides BOTH a model and an OS sandbox** — e.g. a
container job (`bwrap`/`sandbox-exec` available) invoking
`adlc gate-fuzzing --suite .adlc/gate-suite.json` with a configured provider, or a
scheduled Claude routine running inside such a sandbox. Note in the summary that
gate calibration is a deliberate, separate setup and is NOT covered by
`/adlc-maintain` or the deterministic cron.

## 5. Summarize

Report: stale skills (if any), the top hot files to re-prosecute, any stale
tickets found (and whether they were archived), and that gate calibration
(`gate-fuzzing`) is NOT run here or by the deterministic cron and needs a
separate model+sandbox job. Repeated findings surfaced here flow into
`/adlc-distill`.

## Scheduling

The deterministic checks here (`skill-rot`, `model-ratchet`, `ticket-prune`) are
keyless and run well on a cron — deploy the ready-to-use workflow at
`docs/ci/adlc-maintenance.yml` (it scans `.opencode/skills` among other skill
roots). That workflow does **not** run `gate-fuzzing` (it is LLM-backed and
needs an OS sandbox); calibration requires the separate model+sandbox job
described in §4.
