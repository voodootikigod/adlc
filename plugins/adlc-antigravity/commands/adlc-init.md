---
name: adlc-init
description: Bootstrap ADLC in this repo for Antigravity — install the plugin into agy and scaffold .adlc/.
---

# /adlc-init (Antigravity)

Bootstrap the ADLC runtime for use with `agy`.

1. **Install this plugin into agy** (idempotent):
   ```sh
   agy plugin install /absolute/path/to/plugins/adlc-antigravity
   agy plugin list   # confirm "adlc-antigravity" with a "hooks" component
   ```
2. **Initialize the ADLC workspace** (creates `.adlc/`, requires `npm i -g @adlc/cli`):
   ```sh
   adlc init || npx @adlc/cli init
   ```
3. **Add the .gitignore stanza** so only the ticket file is tracked:
   ```
   .adlc/*
   !.adlc/tickets.json
   ```
4. **Wire the CI gate** (the real guarantee): copy `docs/ci/rails-guard.yml` into your
   pipeline and make it a required check. The in-session hook is advisory.
5. **Activate enforcement** for a build: `export ADLC_P4_ENFORCEMENT=1` with an active
   ticket whose `rails[]` are frozen.
