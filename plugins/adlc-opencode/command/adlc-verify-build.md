---
description: Assert the deterministic build gate (G4/P4) — build, lint, and tests must pass before prosecution.
---

# /adlc-verify-build — deterministic build gate (G4, P4)

Before a change can be prosecuted (P5), the build must be clean. This gate runs the
project's build/lint/test commands and records a signed G4/P4 build record.

Target ticket: **$ARGUMENTS** (default to the active ticket).

## Steps
1. Run the configured build, lint, and test commands (from `.adlc/config.json` or
   the project's `package.json`). Capture exit codes.
2. If any fail, STOP — report the failures; the change is not eligible for P5.
3. On success, RECORD the build evidence with
   `adlc gate-manifest record p4-build --files <changed files>` (or, if that is
   unavailable, append an unsigned `p4-build` entry to `.adlc/manifest.jsonl`,
   flagged `unsigned_fallback`). Note: `adlc-runner run p4 --ticket <id>` does
   **not** record — it is a read-only ASSERTION that the P4 evidence is already
   present (it exits 2 on a green build with no prior record), so run it (if the
   runner is available) only AFTER recording, as a confirmation.

## Summarize
Report each command's result and what was recorded. When green, point the user at
`/adlc-prosecute` (P5).
