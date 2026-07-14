---
name: adlc-rail-build
description: Run ADLC P3-P4 rail and build workflows in Codex, including frozen rails, hollow-test, rails-guard, preflight, and flail detection.
---

ADLC_CODEX_SENTINEL_RAIL_BUILD_V1

# ADLC Rail And Build

P3 rails are authored before P4 build and are frozen during P4. Initialize the
project with `$adlc-init`, then select the ticket through the normal ADLC ticket
workflow. The native Codex hook automatically arms when
`.adlc/current-ticket.json` selects an incomplete ticket with non-empty rails.

Use `ADLC_P4_ENFORCEMENT=1` only to force enforcement in automation or unusual
shell workflows. Use `ADLC_P4_ENFORCEMENT=0` only as a deliberate local opt-out;
it does not bypass the authoritative CI gate. `ADLC_TICKET` remains an explicit
selection override when no current-ticket file is present.

Required gates:

```sh
adlc hollow-test --test-cmd "npm test"
adlc preflight --test-cmd "npm test" --json
adlc rails-guard --ticket "$ADLC_TICKET" --tickets .adlc/tickets.json --record --json
adlc flail-detector session.log --json
```

Hooks are immediate guardrails. `adlc rails-guard` and the required CI job are
the deterministic rail-freeze proof.
