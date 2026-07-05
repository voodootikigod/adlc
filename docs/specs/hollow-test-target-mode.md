# Spec — hollow-test target/rails mode + broader operator set

**Addresses:** issues #70, #41, and the hollow-test finding in #35 section B.

## Problem

`hollow-test` was strictly diff-scoped (`changedLinesFromDiff()` off `--base <ref>`) and
unconditionally excluded any path matching `/(?:test|spec)/i`. Two real ticket shapes
defeated it silently:

1. A diff that is **only new test files** (P3 rails-authoring) — `filterTargetFiles()`
   returns zero files, zero mutants are generated, and the CLI exited `0`. Indistinguishable
   from a genuinely strong suite (#70).
2. A **characterization-test** ticket that adds tests for existing, unchanged (frozen-rail)
   code — the behavior file isn't in the diff at all, same false-clear `0`/`0`/`0` exit `0`
   (#41).

Separately, #35 section B found the five original mutation operators never reach guard
sub-terms (`Array.isArray(...)`, a bare truthiness check, a loose `== null` check), a
shrinkable array-literal's contents, or a recursive array-processing ternary branch —
producing false-CLEAR verdicts a manual adversarial mutation pass caught.

## Acceptance criteria

- **AC1 (fail closed on a diff with nothing to mutate):** when `filterTargetFiles()` on the
  actual diff returns zero eligible files and neither `--target` nor `--rails` was given,
  `hollow-test` exits `1` (operational error) instead of `0`.
- **AC2 (`--target <file>`, repeatable):** mutates the named file directly, independent of
  the diff, bypassing the test/spec path exclusion for that file. Whole-file mutation (not
  diff-line-restricted), even if the file also happens to appear in the diff.
- **AC3 (`--rails <ticket-file>`, repeatable):** reads the `rails` glob array from a ticket
  file (either a single-ticket object `{ "rails": [...] }` or a full `tickets.json`-shaped
  file, rails merged across all tickets), expands those globs against `git ls-files`, and
  adds the matches as explicit mutation targets.
- **AC4 (broadened operator set):** three new mutation operators —
  `negate-guard-subclause` (Array.isArray toggle, bare-identifier truthiness, loose `==`/`!=`
  null check), `array-literal-shrink` (drops the last element of a simple array literal),
  and `ternary-swap` (swaps a single-line ternary's two branches) — each demonstrably catch a
  mutation the original five operators produce zero mutants for.

## Verification

```bash
# Unit: new operators (core) + targets.mjs helpers (hollow-test)
node --test packages/core/test/core.test.mjs
node --test packages/hollow-test/test/unit.test.mjs

# Integration: --target / --rails / exit-1-on-test-only-diff
node --test packages/hollow-test/test/hollow-test.test.mjs

# Full package suites (regression check)
node --test packages/hollow-test/test/*.test.mjs
node --test packages/core/test/*.test.mjs
node --test packages/review-calibration/test/*.test.mjs   # shares mutate.mjs operators
node --test packages/rails-guard/test/*.test.mjs           # shares globMatch/loadTickets
```

All of the above exit `0` as of this change.
