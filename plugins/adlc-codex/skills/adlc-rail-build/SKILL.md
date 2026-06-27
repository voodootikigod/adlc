---
name: adlc-rail-build
description: Run ADLC P3-P4 rail and build workflows in Codex, including frozen rails, hollow-test, rails-guard, preflight, and flail detection.
---

ADLC_CODEX_SENTINEL_RAIL_BUILD_V1

# ADLC Rail And Build

P3 rails are authored before P4 build and are frozen during P4.

Set P4 hook enforcement explicitly:

```sh
export ADLC_P4_ENFORCEMENT=1
export ADLC_TICKET=<ticket-id>
```

Required gates:

```sh
adlc hollow-test --test-cmd "npm test"
adlc preflight --test-cmd "npm test" --json
adlc rails-guard --ticket "$ADLC_TICKET" --tickets .adlc/tickets.json --record --json
adlc flail-detector session.log --json
```

Hooks are assistive. `adlc rails-guard` is the deterministic rail-freeze proof.
