---
description: Prosecute a change before merge (P5) — fan out the 5 lenses, verify findings, loop until dry.
---

# /adlc-prosecute — hostile pre-merge review (P5)

Prosecute the change for the active ticket. Requires a clean G4 build
(`/adlc-verify-build`). Target: **$ARGUMENTS** (default to the active ticket).

## 1. Fan out the lenses
Invoke the five prosecution subagents independently, each on the change diff:
`@prosecutor-correctness`, `@prosecutor-security`, `@prosecutor-contract`,
`@prosecutor-diff`, `@prosecutor-tests`. Collect their findings.

## 2. Dedupe
Merge findings across lenses, deduping by file + line range + title, keeping the
highest severity.

## 3. Verify each finding
For each deduped finding, invoke `@prosecutor-verifier` (independently) to refute
it. A finding **survives** only if a strict majority of verification votes confirm
it real; refuted findings are dropped.

## 4. Loop until dry
Repeat fan-out until two consecutive rounds surface no new confirmed findings.

## 5. Record + verdict
Report the surviving findings (severity, file, evidence, recommendation) and a
ship/no-ship verdict. On CLEAR, record prosecution evidence
(`adlc gate-manifest record prosecution --files <changed files>` or `adlc-runner
run p5 --ticket <id>` on the runner path). Material findings block the merge.
