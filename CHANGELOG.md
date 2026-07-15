# Changelog

All notable changes to the `@adlc` suite are documented here.

The suite is released in **lockstep** — every package (`@adlc/core`, the phase
CLIs, the `@adlc/cli` umbrella, and the versioned harness plugins) shares one
version and is published together.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.1] - 2026-07-14

### Fixed
- `@adlc/tickets` shipped without a `repository` field, which caused npm's
  sigstore provenance check to reject it mid-publish and stranded the 1.4.0
  lockstep release after 27 of 34 packages (leaving `@adlc/core@1.4.0`
  uninstallable, since it exact-pins the never-published `@adlc/tickets@1.4.0`).
  Added the missing `repository`/`homepage` metadata.
- **Release safety:** `scripts/release.mjs` now fails closed at bump time if any
  publishable package is missing a `repository.url` that references the source
  repo (`findPublishMetadataProblems`), so a partial provenance publish cannot
  recur — the whole suite ships or none of it does.

> If you installed any `@adlc/*` package at `1.4.0`, upgrade to `1.4.1`.

## [1.4.0] - 2026-07-14

> Partial release — several packages did not publish. Use `1.4.1` or later.

### Added
- **`@adlc/fleet`** — parallel ticket orchestration on the ADLC, with a
  worker-adapter registry spanning the codex, agy, opencode, pi, and cursor
  harnesses, and concurrent live execution.
- **Sharded ticket store** for large backlogs.
- **Native Codex integration.**
- **Cross-model adversarial review gate** for the trust-root tier (P5): a clean
  same-model prosecution of a trust-root change now additionally requires a
  cross-model `approve` from a distinct provider.

### Fixed
- `@adlc/core`: canonicalize symlinked paths in the revision ignore-set, so the
  worktree revision hash is stable when the repo sits under a symlinked path
  (e.g. macOS `/var` → `/private/var`).
- `@adlc/prosecute`: exempt test-only producer/enforcement changes from the
  trust-root tier.
- `@adlc/ticket-prune`: tombstone stale, already-shipped tickets across the
  backlog tools.

## [1.3.0] - 2026-07-11

### Changed
- Renamed the harness plugin packages to short names:
  `@adlc/{pi,opencode,cursor,antigravity}` (from the `-package` suffixes).
- Made `@adlc/cursor` and `@adlc/antigravity` npm-publishable (release-ready).

### Fixed
- `@adlc/opencode`: corrected the last crashing / misdescribed gate references in
  the command suite.

## [1.2.1] - 2026-07-10

### Fixed
- Corrected the `@adlc/opencode` package `repository` field for npm provenance.
- Updated the contact address to `help@agenticlifecycle.ai`.

## [1.2.0] - 2026-07-10

### Added
- **OpenCode integration** (Phases 1–5): enforce-by-default rails guard, a native
  `adlc_gate` tool over a keyless two-phase LLM bridge, a deterministic P5
  prosecutor (`adlc_prosecute`), the `/adlc-maintain` command, shell gating, and
  a build-gate backstop.
- **Pi harness native integration** (Phases 1–5): build-gate on context usage,
  flail steering, the `/adlc` command surface with live widgets, a deterministic
  P5 prosecutor, and P6 integrate + rollback.
- **Cursor native-parity integration**: command suite, `/adlc-prosecute`, and
  hook parity.
- **`agenticlifecycle.ai` marketing site.**
- **T36 rails completion lifecycle** — a completed ticket's build-time rails
  auto-expire.
- `@adlc/build-gate`: a machine-checkable fitness-to-build gate.
- Per-invocation `--provider` / `--providers` model selection across the tools.
- A risk-gated adversarial-review CI template.

### Changed
- Consolidated the replicated per-phase model routers into a single generated
  source (T13/T14).

### Fixed
- Hardened text-scanning gates and closed the P5 → P7 loop.
- `@adlc/spec-lint`, `@adlc/review-calibration`, `@adlc/hollow-test`, and the
  prompt-only gate verdicts (`coldstart`/`premortem`/`parallax`) received
  correctness fixes.

## [1.1.0] - 2026-06-23

### Added
- **ADLC Claude Code plugin** with rail-guard enforcement (Phases A–F).
- **Codex-native ADLC integration** with hardened rail-hook enforcement.
- **OpenCode integration** — rails-guard plugin, keyless two-phase LLM-gate
  bridge, advisory session hooks, and prosecutor lenses (Phases A–F).
- **Pi harness** deep native integration.
- **Antigravity (agy)** native rails-guard integration.
- **Cursor** native rails-guard integration (MVP).
- **`@adlc/ticket-sync`** — external ticketing sync.
- **ADLC documentation site** (Fumadocs).

### Fixed
- Guarded unhandled `JSON.parse` in the gate and `gh` helpers.
- Resolved `/plugin install` "Marketplace not found" regression and unified the
  plugin install on the `plugins` npm package.

## [1.0.2] - 2026-06-14

### Changed
- Maintenance release — packaging and lockfile alignment.

## [1.0.1] - 2026-06-14

### Changed
- Hardened the npm publish supply chain.
- Added open-source contribution setup and documentation.

## [1.0.0] - 2026-06-13

### Added
- Initial public release of the ADLC toolkit: 18 gate-shaped, zero-dependency
  phase tools built via a parallel build → prosecute → fix workflow.
- The ADLC specification and the frozen `@adlc/core` contract (`llm`, `git`,
  `cli`, `ledger`, `tickets`, `mutate`).
- Lockstep `/release` tooling for the suite.

[1.4.1]: https://github.com/voodootikigod/adlc/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/voodootikigod/adlc/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/voodootikigod/adlc/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/voodootikigod/adlc/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/voodootikigod/adlc/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/voodootikigod/adlc/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/voodootikigod/adlc/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/voodootikigod/adlc/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/voodootikigod/adlc/releases/tag/v1.0.0
