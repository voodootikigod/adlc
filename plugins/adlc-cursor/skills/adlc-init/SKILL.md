---
name: adlc-init
description: >-
  Initialize or refresh ADLC for Cursor. Use for first-time setup, bootstrap
  `.adlc/`, or repair missing runtime config. Marketplace → CLI → init → CI.
---

<!-- ADLC_CURSOR_SENTINEL_INIT_V1 -->

# Initialize ADLC for Cursor (one flow)

Preferred UX after installing the **ADLC for Cursor** marketplace plugin:

1. Detect `adlc` on PATH (`adlc --version`), else `npm install -g @adlc/cli`.
2. `adlc init --harness cursor --json` — runtime only; hooks/skills come from the plugin.
3. Wire `docs/ci/rails-guard.yml` as a required CI check.
4. `adlc preflight --json` and point the user at `/adlc-ticket`.

Do **not** require `npx @adlc/cursor` for normal users.

## Legacy / local-dev fallback

```sh
npx @adlc/cursor .
```

Idempotent scaffolder for contributors. Prefer marketplace so hooks/skills update
with the plugin.

## Honesty

- MCP wrapper landed / channel unverified until Roots proof.
- Prosecutor agents packaged-but-unverified until fan-out proof.
- Marketplace listing URL: do not fabricate (see publish checklist in
  `docs/integrations/cursor.md`).
