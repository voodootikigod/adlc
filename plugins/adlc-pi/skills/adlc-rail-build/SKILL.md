---
name: adlc-rail-build
description: Run ADLC P3-P4 rail and build workflows in Pi, including frozen rails, hollow-test, rails-guard, preflight, and flail detection.
---

# ADLC Rail And Build (Pi Integration)

P3 rails are authored before P4 build and are frozen during P4.

The Pi `adlc-pi-extension` automatically intercepts and enforces rail-freeze and suppression-marker rules! Ensure that you have the active ticket set:

```sh
export ADLC_TICKET=<ticket-id>
```

Or make sure `.adlc/current-ticket.json` is set to your current ticket.

Required gates and checks:

```sh
adlc hollow-test --test-cmd "npm test"
adlc preflight --test-cmd "npm test" --json
adlc rails-guard --ticket "$ADLC_TICKET" --tickets .adlc/tickets.json --record --json
adlc flail-detector session.log --json
```

Inside Pi, prefer the native `adlc_gate` tool (e.g. `adlc_gate({gate: "rails-guard", args: "--ticket $ADLC_TICKET --tickets .adlc/tickets.json"})`) over shelling these `adlc <gate>` commands — it enforces the rails-aware argv policy and records gate evidence automatically; the CLI shown above stays the fallback for gates it denies (write/derived-target gates and `--*cmd` invocations).

Hooks are assistive. `adlc rails-guard` is the deterministic rail-freeze proof.
