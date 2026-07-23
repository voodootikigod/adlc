---
name: adlc-doctor
description: Environment, ticket pointer, and plugin health check for Antigravity ADLC integration.
---

# /adlc-doctor (Antigravity)

Run diagnostic environment and health checks for the Antigravity ADLC integration:

```sh
node plugins/adlc-antigravity/hooks/adlc-rails-guard.cjs doctor
```

## Diagnostics Sequence
1. **Node Environment:** Asserts Node >= 18 (Node 22+ recommended).
2. **Antigravity CLI:** Asserts `agy` is present on `$PATH` and authenticated.
3. **ADLC Workspace:** Validates `.adlc/` ticket store structure and `.gitignore` exclusions.
4. **Active Ticket Pointer:** Validates `.adlc/current-ticket.json` and checks for conflicting `ADLC_TICKET` env settings.
5. **Plugin Manifest:** Asserts `@adlc/antigravity` plugin is installed with valid `plugin.json` `adlcContract`.
6. **CI Rail-Guard:** Verifies `.github/workflows/adlc-rails-guard.yml` (or equivalent CI gate) is configured.
