---
name: adlc-init
description: Initialize or refresh an ADLC repository for Codex. Use for first-time ADLC setup, requests to bootstrap `.adlc/`, install project-scoped ADLC subagents, or repair missing Codex repository configuration.
---
<!-- ADLC_CODEX_SENTINEL_INIT_V1 -->

# Initialize ADLC for Codex

1. Run `adlc init --help` to confirm the installed CLI contains the initializer.
   If it does not, stop and direct the user to the source-checkout command in the
   Codex integration guide; do not imply that an older registry release has it.
2. Run `adlc init --json` from the repository root.
3. Inspect the returned `created`, `updated`, `unchanged`, and `warnings` fields.
4. Confirm `.adlc/config.json`, `.adlc/specs/`, and the three
   `.codex/agents/adlc-*.toml` profiles exist.
5. Run `adlc preflight --json` and report any failed readiness check.

The initializer is idempotent and preserves project-owned files. Never edit or copy
files into `~/.codex`; Codex project agents belong under the repository's
`.codex/agents/` directory.
