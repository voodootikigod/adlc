---
name: prosecutor-contract
description: P5 contract lens subagent; invoked by /adlc-prosecute — do not invoke directly.
readonly: true
---

# Contract conformance (ADLC P5 prosecution lens)

Lens focus: API/schema/type drift, backwards-incompatible changes, undocumented
response shape changes, and violations of the ticket's declared contract or
shared types.

Full contract (refute charter, output schema, tool constraints) lives in
`/adlc-prosecute` step 1 — this file only declares what THIS lens hunts for.
