---
description: Assert the deterministic build gate (G4/P4) — build, lint, targeted tests, and flail detection must be clean before prosecution.
argument-hint: "[ticket]"
---

# /adlc-verify-build — deterministic build gate (G4, P4)

Before a change can be prosecuted (P5), the build must be clean. This gate runs
the project's build/lint/test commands, checks the build session for flail, and
records a G4/P4 build record. Target ticket: `$ARGUMENTS` (default to the active
ticket in `.adlc/current-ticket.json`). See the `adlc-rail-build` skill for the
command reference.

## Steps
1. Run the configured build, lint, and test commands (from `.adlc/config.json` or
   the project's `package.json`). Capture exit codes and keep the output in a
   log file.
2. Run a **targeted** test pass for the active ticket: the test files covering
   the ticket's `scope` globs (e.g. `node --test <matching test files>`), so a
   green full suite can't mask a skipped local suite.
3. Check the session for flail: `adlc flail-detector <log-file> --scope <glob>
   --record --ticket <id>` (use the ticket's `scope` globs). It flags repeated
   errors, scope violations, edit churn, and oversized logs — exit `2` means the
   build session itself is unhealthy; investigate before proceeding. On a clean
   verdict, `--record` appends the `flail-check` manifest entry `adlc run p4`
   requires.
4. If any of the above fail, STOP — report the failures; the change is not
   eligible for P5.
5. On success, record the build evidence:
   `adlc gate-manifest record p4-build --ticket <id> --files <changed files>
   --data '{"tests":"<command run>","result":"green","flail":"<verdict>"}'`.
   (`adlc run p4` is a read-only ASSERTION requiring `p4-build`/`rails-check`/
   `flail-check` manifest entries — the `p4-build` record above and the
   `flail-check` record from step 3 cover two of the three; `rails-check` comes
   from `adlc rails-guard --record` at P3. With all three recorded for this
   ticket, `adlc run p4 --ticket <id>` should now exit 0.)

## Summarize
Report each command's result, the flail verdict, and what was recorded. When
green, point the user at `/adlc-prosecute` (P5).
