# @adlc/hook-engine

Shared runtime core for ADLC harness hooks across all 7 shipped harnesses (`claude-code`, `codex`, `copilot`, `cursor`, `gemini`, `opencode`, `pi`).

## Modules

- `lib/pretool.mjs` — `enclosingAdlcRoot`, symlink-resolved `railHit` with ancestor-directory deletion protection, `@adlc/core` `globMatch` & `classifyShellCommand` / `collectPatchPaths`, active ticket rail resolution, and `evaluatePreTool`.
- `lib/posttool.mjs` — PostToolUse audit and `@adlc/flail-detector` signal evaluation (`evaluatePostTool`).
- `lib/stop.mjs` — Stop / P5 gate combining `@adlc/build-gate` risk derivation and segmented `.adlc/manifest.d/*.jsonl` + root `.adlc/manifest.jsonl` evidence detection (`hasManifestEvidence`, `evaluateStop`).
- `lib/session-start.mjs` — SessionStart context builder resolving active ticket, rails, and risk tier (`evaluateSessionStart`).
- `lib/protocol-adapters.mjs` — `normalizeHookInput` and `formatHookOutput` across all 7 harness wire protocols.

## Compilation

Zero-dependency standalone ESM/CJS hook bundles are compiled with `node scripts/build-hooks.mjs`.
