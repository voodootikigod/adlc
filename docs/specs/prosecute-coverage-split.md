# Spec — Split `@adlc/prosecute` test coverage by concern (closes #68)

**Type:** Lightweight P1 record for a test-only change. No behavior in `lib/run.mjs` or
`lib/schema.mjs` changed.

## Problem

`packages/prosecute` (435 lib lines across `lib/run.mjs` + `lib/schema.mjs`) was covered by a
single 673-line `test/prosecute.test.mjs`, unlike `packages/gate-fuzzing`'s one-file-per-concern
split (10 files). `prosecute` is the P5 evidence ledger — the trust boundary between "the gate
ran enough times, with enough independent lenses, on the actual current code" and a rubber-stamped
stale/under-diversified pass — so its dry-lens counting, consecutive-dry-pass tracking, and
revision-binding logic warrant dedicated, boundary-focused tests rather than one integration file.

## What changed

Deleted `test/prosecute.test.mjs` and replaced it with `test/helpers.mjs` (shared fixtures) plus
six per-concern files:

- `test/prosecute-dry-lenses.test.mjs` — `finalDryLenses()` / `dryLenses.size >= 3` boundary
  (2 distinct trailing lenses fails, 3 passes, repeated lenses don't double-count).
- `test/prosecute-consecutive-dry.test.mjs` — `consecutiveDry` increment/reset semantics,
  asserted per-pass via `result.passes[i].consecutiveDry`, including that a non-dry pass
  (even an all-killed one) resets the streak.
- `test/prosecute-revision-binding.test.mjs` — `resolveRevision()`, `transcriptProof()`,
  `reviewPacketProof()`, and `seedOpenFindingsFromManifest()`; adds explicit staleness-rejection
  cases (transcript/review-packet bound to a different revision than the one being prosecuted)
  and a case proving a finding recorded under a stale revision does not block a fresh revision.
- `test/prosecute-findings-lifecycle.test.mjs` — open/killed finding identity tracking within a
  single run.
- `test/prosecute-schema-validation.test.mjs` — op-error paths (bad schema, missing/undefined
  ticket, missing attestation).
- `test/prosecute-cli.test.mjs` — `bin/adlc-prosecute.mjs` subprocess smoke tests.

No bug was found in `lib/run.mjs`/`lib/schema.mjs` while writing these tests; every new
boundary/staleness case matched existing behavior on the first run except one test-authoring
mistake (a fixture file-path collision that was fixed in the test itself, not the library).

## Acceptance criteria

- **AC1** — *Verify:* `cd packages/prosecute && npm test` exits 0 — all prosecute tests pass.
- **AC2** — *Verify:* `node --test packages/prosecute/test/prosecute-dry-lenses.test.mjs` exits 0 —
  the dry-lens boundary is covered: 2 distinct trailing dry lenses fails with
  `/fewer than three distinct dry lenses/`, 3 distinct passes.
- **AC3** — *Verify:* `node --test packages/prosecute/test/prosecute-consecutive-dry.test.mjs`
  exits 0 — a non-dry pass between two dry passes resets `consecutiveDry` to 0, asserted
  per-pass via `result.passes[i].consecutiveDry`.
- **AC4** — *Verify:* `node --test packages/prosecute/test/prosecute-revision-binding.test.mjs`
  exits 0 — stale/mismatched revision evidence (transcript and review packet) is rejected, and a
  finding recorded under a stale revision does not block a fresh revision.
- **AC5** — *Verify:* `for d in packages/*/test; do node --test "$d"/*.test.mjs || exit 1; done`
  exits 0 — no regression in any other package.

## Out of scope — tracked follow-up

Issue #68 also asked to link the `gate-fuzzing` repro-harness TODO
(`packages/gate-fuzzing/lib/record.mjs:91` — the `t.todo('Implement RED test from repro: ...')`
stub inside `buildRedTestScaffold()`) as a tracked checklist item, since it's the same
"auto-generated scaffold vs. real enforcement" gap in spirit as prosecute's coverage thinness.
That TODO is a separate, substantial piece of work (wiring a real git-repo/apply-diff/run/assert
harness) and is intentionally *not* implemented in this test-only PR. It is now tracked as
**ticket T15** in `.adlc/tickets.json` ("Wire the gate-fuzzing repro-harness TODO into a real RED
test (record.mjs:91)") so it isn't lost.

- [ ] T15 — implement the real repro harness for `packages/gate-fuzzing/lib/record.mjs:91`
  (see `.adlc/tickets.json`, ticket `T15`).

## Verification commands

```bash
cd packages/prosecute && npm test
```

```bash
cd /home/voodootikigod/Projects/voodootikigod/adlc/.worktrees/prosecute-coverage-split
for d in packages/*/test; do node --test "$d"/*.test.mjs || exit 1; done
```
