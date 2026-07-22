---
name: adlc-init
description: Initialize or refresh an ADLC repository for the GitHub Copilot CLI. Use for first-time ADLC setup, requests to bootstrap `.adlc/`, or repair missing Copilot repository configuration.
---
<!-- ADLC_COPILOT_SENTINEL_INIT_V1 -->

# Initialize ADLC for the GitHub Copilot CLI

1. Run `adlc init --help` to confirm the installed CLI contains the initializer.
   If it does not, stop and direct the user to the source-checkout command in the
   GitHub Copilot CLI integration guide; do not imply that an older registry
   release has it.
2. Run `adlc init --harness copilot --json` from the repository root.
3. Inspect the returned `created`, `updated`, `unchanged`, and `warnings` fields.
4. Confirm `.adlc/config.json` and `.adlc/specs/` exist. The six read-only
   prosecution agents (`agents/adlc-prosecutor-*.agent.md`) ship with the plugin —
   `adlc init` bootstraps only the committable `.adlc/` runtime, it does not write
   agent profiles into the repository.
5. Run `adlc preflight --json` and report any failed readiness check.

The initializer is idempotent and preserves project-owned files. `adlc init` may
write a **local** `.adlc/config.json`; do **not** commit it into a repo that
already has frozen rails on the base branch — CI treats `.adlc/config.json` as a
trust root once any base ticket declares rails. Then wire the unbypassable CI
rail-freeze gate (`rails-guard-ci`) as a required check — the unbypassable tier.
The in-session rails hook enforces headless (its deny-ask defaults to deny) unless
the session runs with `--allow-all-tools`, which auto-approves it.
