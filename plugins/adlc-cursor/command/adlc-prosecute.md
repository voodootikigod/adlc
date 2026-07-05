---
description: Prosecute a change before merge (P5) — run the deterministic prosecution gates and the cross-model adversarial review.
---

# /adlc-prosecute — pre-merge prosecution (P5)

Prosecute the change for the active ticket. Requires a clean G4 build
(`/adlc-verify-build`). Target: the text after the command (default to the
active ticket).

> **Note:** the full multi-lens prosecution loop (independent lenses, cross-lens
> dedupe, verifier refutation, loop-until-dry) is not yet wired for Cursor. Until
> it lands, run the deterministic prosecution gates below directly.

## 1. Hollow-test — are the tests load-bearing?
Run `adlc hollow-test --test-cmd "<the project's test command>"`. It mutates the
changed code to find tests that pass without actually testing the behavior.
Exit `2` = hollow tests found; fix them before merging.

## 2. Behavior-diff — is the change visible?
Run `adlc behavior-diff capture …` before/after (or against the base branch) and
`adlc behavior-diff compare before.json after.json` to make the behavior change
visible for the P6 human gate.

## 3. Cross-model adversarial review
Run `npx adversarial-review --providers <a,b>` (≥2 distinct providers on the
risk gate) — a fresh-context, cross-model ship/no-ship review. The default
invocation is single-shot: fix its findings and re-run until it exits 0
(`exit 0 = SHIP`; the autonomous review→fix loop is the separate opt-in
`--loop` mode, which needs a write sandbox). If no API keys are configured,
use `npx adversarial-review --prompt-only` and answer the review prompt
yourself, but prefer a genuinely different model for security-critical
changes.

## 4. Record + verdict
Report the findings and a ship/no-ship verdict. On CLEAR, record prosecution
evidence: `adlc gate-manifest record prosecution --files <changed files>`.
Material findings block the merge.
