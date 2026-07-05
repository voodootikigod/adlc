---
description: Assert the deterministic build gate (G4/P4) — build, lint, targeted tests, and flail detection must be clean before prosecution.
---

# /adlc-verify-build — deterministic build gate (G4, P4)

Before a change can be prosecuted (P5), the build must be clean. This gate runs
the project's build/lint/test commands, checks the build session for flail, and
records a G4/P4 build record.

Target ticket: the text after the command (default to the active ticket in
`.adlc/current-ticket.json`).

## Steps
1. Run the configured build, lint, and test commands (from `.adlc/config.json` or
   the project's `package.json`). Capture exit codes and keep the output in a
   log file.
2. Run a **targeted** test pass for the active ticket: the test files covering
   the ticket's `scope` globs (e.g. `node --test <matching test files>`), so a
   green full suite can't mask a skipped local suite.
3. Check the session for flail: `adlc flail-detector <log-file> --scope <glob>`
   (use the ticket's `scope` globs). It flags repeated errors, scope violations,
   edit churn, and oversized logs — exit `2` means the build session itself is
   unhealthy; investigate before proceeding.
4. If any of the above fail, STOP — report the failures; the change is not
   eligible for P5.
5. On success, record the build evidence:
   `adlc gate-manifest record p4-build --ticket <id> --files <changed files>
   --data '{"tests":"<command run>","result":"green","flail":"<verdict>"}'`.
   (Note: `adlc-runner run p4` is a read-only ASSERTION requiring
   `rails-green`/`rails-check`/`flail-check` manifest entries — of which the
   current toolkit only ever emits `rails-check` (via `adlc rails-guard
   --record`) — so it exits 2 even after this step. Formal `run p4` assertion
   is not currently satisfiable from this command's flow; the `p4-build`
   record above IS the P4 evidence.)

## Summarize
Report each command's result, the flail verdict, and what was recorded. When
green, point the user at `/adlc-prosecute` (P5).
