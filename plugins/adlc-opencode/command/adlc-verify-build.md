---
description: Assert the deterministic build gate (G4/P4) — build, lint, and tests must pass before prosecution.
---

# /adlc-verify-build — deterministic build gate (G4, P4)

Before a change can be prosecuted (P5), the build must be clean. This gate runs the
project's build/lint/test commands and records a signed G4/P4 build record.

Target ticket: **$ARGUMENTS** (default to the active ticket).

## Steps
1. Run the configured build, lint, and test commands (from `.adlc/config.json` or
   the project's `package.json`). Capture exit codes and keep the output in a
   log file.
2. If any fail, STOP — report the failures; the change is not eligible for P5.
3. Check the session for flail: `adlc flail-detector <log-file> --record --ticket
   <id>` (add `--scope <glob>` when the ticket declares scope globs). It flags
   repeated errors, scope violations, edit churn, and oversized logs — exit `2`
   means the build session itself is unhealthy; investigate before proceeding.
   On a clean verdict, `--record` appends the `flail-check` manifest entry
   `adlc-runner run p4` requires.
4. On success, RECORD the build evidence with
   `adlc gate-manifest record p4-build --ticket <id> --files <changed files>`
   (or, if that is unavailable, append an unsigned `p4-build` entry to
   `.adlc/manifest.jsonl`, flagged `unsigned_fallback`). `adlc-runner run p4` is
   a read-only ASSERTION requiring `p4-build`/`rails-check`/`flail-check`
   manifest entries — the `p4-build` record above and the `flail-check` record
   from step 3 cover two of the three; `rails-check` comes from `adlc
   rails-guard --record` at P3. With all three recorded for this ticket,
   `adlc-runner run p4 --ticket <id>` should now exit 0.

## Summarize
Report each command's result, the flail verdict, and what was recorded. When
green, point the user at `/adlc-prosecute` (P5).
