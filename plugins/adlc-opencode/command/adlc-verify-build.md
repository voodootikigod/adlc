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
3. On success, record the build evidence:
   `adlc-runner run p4 --ticket <id>` (or, if the runner is unavailable, append an
   unsigned `p4-build` entry to `.adlc/manifest.jsonl`, flagged `unsigned_fallback`).

## Summarize
Report each command's result and what was recorded. When green, point the user at
`/adlc-prosecute` (P5).
