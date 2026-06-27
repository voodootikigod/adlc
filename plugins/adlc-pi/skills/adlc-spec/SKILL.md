---
name: adlc-spec
description: Run ADLC P0-P2 specification, interrogation, ticket decomposition, cold-start, merge forecast, and model routing workflows in Pi.
---

# ADLC Spec (Pi Integration)

Drive P0-P2 with executable acceptance criteria.

Commands:

```sh
adlc parallax --request "<request>"
adlc spec-lint spec.md --json
adlc premortem spec.md --json
adlc coldstart --all --tickets .adlc/tickets.json --json
adlc merge-forecast --tickets .adlc/tickets.json --json
adlc model-router --tickets .adlc/tickets.json --json
```

Stop for human approval after P1 spec approval. Do not mark P2 complete until the ticket DAG and cold-start checks pass.
