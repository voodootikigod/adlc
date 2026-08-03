---
name: adlc-doctor
description: Environment, ticket pointer, and plugin health check for Google Gemini ADLC integration.
---

# /adlc-doctor (Gemini)

Run diagnostic environment and health checks for the Google Gemini ADLC integration:

```sh
node plugins/adlc-gemini/hooks/adlc-rails-guard.cjs doctor
```

## Diagnostics Sequence
1. **Node Environment:** Asserts Node >= 18 (Node 22+ recommended).
2. **Gemini Host:** Asserts `agy` or `jetski` is present on `$PATH` and authenticated.
3. **ADLC Workspace:** Validates `.adlc/` ticket store structure and `.gitignore` exclusions.
4. **Active Ticket Pointer:** Validates `.adlc/current-ticket.json` and checks for conflicting `ADLC_TICKET` env settings.
5. **Plugin Manifest:** Asserts `@adlc/gemini` plugin is installed with valid `plugin.json` `adlcContract`.
6. **CI Rail-Guard:** Verifies `.github/workflows/adlc-rails-guard.yml` (or equivalent CI gate) is configured.
