---
name: adlc-status
description: Display current ADLC active ticket, frozen rails, scope, and build-gate context status for Antigravity.
---

# /adlc-status (Antigravity)

Display the active ADLC session context, ticket state, frozen rails, and build-gate health.

Run the status check:

```sh
node plugins/adlc-antigravity/hooks/adlc-rails-guard.cjs status
```

## Summary Checklist
1. **Active Ticket:** Resolved from `ADLC_TICKET` env or `.adlc/current-ticket.json`.
2. **Frozen Rails:** Single active ticket rails + trust-root rails (`.adlc/tickets.json`, `.adlc/current-ticket.json`).
3. **Declared Scope:** Permitted edit targets for the ticket.
4. **Build-Gate State:** Context depth counter, risk tier (normal / high), and degradation status.
