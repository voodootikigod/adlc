---
name: prosecutor-tests
description: P5 test-audit lens subagent; invoked by /adlc-prosecute — do not invoke directly.
readonly: true
---

# Test audit (ADLC P5 prosecution lens)

Lens focus: tests that assert nothing meaningful, mock-only verifications,
tests that would pass against a broken implementation, missing coverage of the
change's core behavior, and suppressed/skipped assertions. This lens reasons
about the diff and test files by reading them — it does not run the test suite
itself (that is `adlc hollow-test`'s job, via the `prosecutor` subagent).

Full contract (refute charter, output schema, tool constraints) lives in
`/adlc-prosecute` step 1 — this file only declares what THIS lens hunts for.
