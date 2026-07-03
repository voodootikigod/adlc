# Spec — review-calibration provider-independence guard (issue #64)

## Issue

`packages/review-calibration` resolves its LLM judge via the same auto-detect
provider path as everything else in the toolkit (`detectProvider`/`complete` from
`@adlc/core`), while the reviewer-under-test runs as an opaque subprocess via
`--review-cmd`. Nothing compared the two, so the tool's core claim — "who reviews
the reviewer" — could be silently satisfied by the judge and the reviewer being the
same model family, defeating the cross-model independence rationale in ADR-0007.
The issue also noted `lib/*.mjs` (1032 lines, 8 files) was covered by exactly one
monolithic test file.

## Acceptance criteria

- A new `--review-provider <name>` flag lets the caller declare which
  provider/model family `--review-cmd` actually runs on (the subprocess can't be
  introspected generically).
- The declared `--review-provider` is compared (case-insensitively, with common
  aliases like `claude`→`anthropic`, `gpt`→`openai`, `google`→`gemini`) against the
  judge's resolved provider (`detectProvider().name`).
- If they match: warn to stderr by default (gate still governed by recall/precision);
  with `--strict`, gate-fail with exit code 2 instead.
- `--strict` without `--review-provider` is an operational error (exit 1) — there is
  nothing to compare.
- If `--review-provider` is omitted, no comparison is attempted and no warning is
  printed (unchanged behavior).
- Dedicated per-concern test files exist for `lib/judge.mjs` and `lib/scorer.mjs`
  (`test/judge.test.mjs`, `test/scorer.test.mjs`), matching the one-file-per-concern
  pattern used in `packages/gate-fuzzing/test/*.test.mjs`. The prior monolithic
  `test/review-calibration.test.mjs` no longer duplicates those unit tests; it keeps
  CLI/E2E and other-module coverage (including new CLI-level tests for the guard).
- Full REDESIGN.md v2 migration (plant/defect/witness schema) is explicitly out of
  scope for this branch — see `packages/review-calibration/REDESIGN.md`.

## Verification commands

```bash
cd packages/review-calibration
node --test test/judge.test.mjs
node --test test/scorer.test.mjs
node --test test/review-calibration.test.mjs
npm test   # full package suite (all *.test.mjs)
```

All of the above pass (98/98 tests across the three files as of this change).
