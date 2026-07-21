# Changelog

All notable changes to the `@adlc` suite are documented here.

The suite is released in **lockstep** — every package (`@adlc/core`, the phase
CLIs, the `@adlc/cli` umbrella, and the versioned harness plugins) shares one
version and is published together.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.1] - 2026-07-21

Two defects in this release had been shipping silently for weeks. Both were
invisible to the test suite because every gate validated the source tree, never
the artifact a user actually installs.

### Fixed

- **claude-code: the plugin now tracks releases again.** `.claude-plugin/marketplace.json`
  and the plugin manifest had been frozen at `0.2.0` since 1.2.x, so `/plugin`
  reported "already at the latest version (0.2.0)" while `main` carried current
  content. `/plugin` compares the *declared version string* to decide whether an
  update exists, so every release since was invisible to the updater. Manifest
  discovery in `scripts/release.mjs` is now glob-driven by directory shape, and
  the drift gate shares the same discovery — so Codex, Cursor, antigravity and
  any future harness stay in lockstep without a per-host code change. (#214)

- **ticket-sync: `adlc ticket doctor` no longer crashes on install.** The
  published tarball omitted `scripts/gen-schema.mjs`, which `lib/doctor.mjs`
  imports at module load, so the command died with `ERR_MODULE_NOT_FOUND` for
  every npm-installed user of 1.5.0. (#214)

- **release: the publish path now validates the artifact, not the source tree.**
  A new gate asks npm which files a package will actually ship, parses each one
  with a real JS parser, and fails the release closed if any shipped file
  imports something the `files` allowlist excludes — covering `bin`, `main` and
  every `exports` target. A package npm cannot be consulted about is reported as
  *unverified* rather than passing as clean. See ADR-0011. (#214)

- **codex: read-only searches are no longer denied.** The rails-guard split shell
  payloads on `|` without respecting quoting, so `rg '"(a|b|c)"' .` was shredded
  into fragments that failed the read-only allowlist — blocking legitimate
  searches, including cross-model review runs. Splitting is now quote-aware and
  fails closed on an unterminated quote. (#219)

- **source hygiene: raw control bytes removed and guarded.** Literal `NUL` bytes
  in `packages/core/lib/git.mjs` and `plugins/adlc-pi/lib/reactive-gate.mjs`
  made git classify those files as *binary*, so no diff of them rendered as text
  anywhere — including in pull requests. A new check rejects raw control
  characters and Trojan-Source bidirectional overrides in tracked text files.
  (#218)

## [1.5.0] - 2026-07-20

### Added
- **codex/claude-code:** close 5 Codex/Claude Code parity gaps (#201) — port the
  multi-lens P5 prosecutor fan-out and the risk-tier build gate to Codex, add
  a Stop-time adversarial-review nudge, bring Codex skill docs up to Claude
  Code's depth, and give Claude Code an MCP server with compaction hooks.
- **ci:** report ceremony drift into a tracking issue (#203) (#207)
- **ticket-prune:** ticket-completion / rail-cleanup lifecycle step (#198) (#200)
- **cursor:** ship adlc-cursor as Cursor marketplace plugin (T47) (#186)

### Fixed
- **claude-code:** completion expires a ticket's in-session rails (#162) (#202)
- **tickets:** make the active-ticket pointer one validated fail-closed contract (#196)
- **plugins:** ship the generated ticket readers in the npm tarballs (#193) (#195)
- **codex:** repair MCP startup and npm install docs (#192)

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
