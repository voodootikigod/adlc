# Changelog

All notable changes to the `@adlc` suite are documented here.

The suite is released in **lockstep** — every package (`@adlc/core`, the phase
CLIs, the `@adlc/cli` umbrella, and the versioned harness plugins) shares one
version and is published together.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.0] - 2026-08-08

### Added
- **context-handoff:** the slice-2 CLI — `write`, `resume`, `bypass`, `repair`,
  and `unlock` verbs on `@adlc/context-handoff` (T155) (#460)

### Fixed
- **gate-manifest:** `enable` now discloses that rails-guard cannot yet validate
  `.adlc/manifest.d/` segment files, on every outcome that describes a repository
  actually in forest mode — activation, already-enabled, the already-active
  gitignore-drift refusal, and the keyless refusal (via a bounded, no-follow
  probe). When a bounded read cannot decide, the warning says so
  (`segmentation-undetermined`) instead of claiming forest mode it never
  established. The gap itself closes with the forest CI gate
  (T-MANIFEST-FOREST slice 6), which removes the warning. (#465)
- **integrations:** ADLC no longer creates or trusts `~/.adlc` — a home-directory
  workspace silently captured every project below it (#463)
- **release:** packages now publish in true dependency order — the previous
  core-first/directory order had 17 inversions (including `@adlc/core` pinning
  `@adlc/tickets` 29 slots later), so a mid-run publish failure could strand
  already-published packages uninstallable (#468)

## [1.8.0] - 2026-08-06

### Added
- **gate-manifest:** the segmented ("forest") evidence store is now **reachable and
  supported**. `adlc gate-manifest enable` activates it on a greenfield repo and
  `adlc gate-manifest adopt` is the supported remediation for an ambiguous lineage;
  the segment writer, generation descriptor, and adoption-record schema complete the
  write side. Single-file storage remains a permanent, fully supported mode — this is
  a documented dual-mode adapter, not a migration with a deadline (#439, #440, #420, #411)
- **gemini:** the Antigravity and JetSki integrations are unified into a single
  `@adlc/gemini` integration (#452)
- **quartermaster:** new `@adlc/quartermaster` package — an operator-local channel
  registry and `routeJob` (T151) (#402)
- **context-handoff:** new `@adlc/context-handoff` package — the slice-1 deny gate
  and its contract tests (T154) (#448)
- **trust-root:** the manifest signing key is an explicit, validated, required
  parameter at every library boundary, and the test runner scrubs it from spawned
  segments — a gate can no longer sign with a key it merely inherited (#410, #406)
- **fleet:** per-phase token spend is now recorded on the P4/P5 write side (#422)
- **distill / hygiene:** deterministic P7 gate for authority-smuggling source
  comments, plus a declare-and-neutralize guard for ADLC entrypoint spawns (#432, #414)

### Fixed
- **fleet:** the transport now selects the credential, so a subscription seat cannot
  be silently metered; the dispatch seat is re-derived per attempt so a failed strike
  climbs the ladder; and the ledger signing key is denied to the review subprocess
  (#447, #444, #453)
- **gate-manifest:** lineage recovery survives fresh clones and branch switches; an
  UNMEASURED call is counted rather than discarded, so the barbell has a shape; and
  fleet's phase gates map correctly, so P4 spend is attributed to P4 (#415, #449, #426)
- **core, tickets, gate-manifest:** the manifest `.gitignore` contract now reaches all
  four copies, so scaffolded repos can commit their manifest evidence (#450, #442)
- **cli:** termination signals are forwarded to the tool child instead of orphaning it
  (#431)
- **hollow-test:** a mutant stranded by an interrupted run can be recovered (#430)
- **install:** Antigravity install no longer fails on `agy` parsing the plugin path as
  `plugin@marketplace` (#394)
- **router:** a rename shim expires once the baseline holds the rename (#461)
- **docs:** Vercel Skew Protection no longer breaks the Twitter card image (#392)

## [1.7.0] - 2026-07-29

### Added
- **gate-manifest / prosecute:** cross-model manifest forest — a read layer plus a
  cross-model reader that walks it and closes the prior TRUNCATION gap
  (T-MANIFEST-FOREST slices 1–2) (#384, #389, #355, #387)
- **herdr:** new `adlc-herdr` plugin — ADLC lifecycle visibility at the
  terminal-multiplexer layer, built out across board/palette actions, event glue,
  a fleet observer bridge, and marketplace auto-sync (#333, #340, #346, #357, #360)
- **copilot:** `plugins/adlc-copilot`, the 7th ADLC harness integration (#242, #290)
- **cursor / antigravity:** native integration parity build-out, anti-flail
  handling, and marketplace branding fixes (#241, #294, #305, #318)
- **install:** one-command install, `skills.sh` distribution, install CTA above
  the fold, and agent-led onboarding (#351)
- **tickets:** make `adlc ticket` self-describing, and close what that surfaced (#366)
- **marketing:** rebuild the marketing site as a controlled-change record; add
  Copilot to the integration set; make `@adlc/herdr` a publish target (#371, #361)

### Fixed
- **docs:** marketing site design polish — impeccable critique fixes, P0 claims/form, exhibits everywhere (#385)
- **gate-manifest:** scope legacy-unsigned tolerance to the honest prefix; record-cross-model now
  fails closed without a signing key; node24 action pins in the shipped rails-guard template (#378, #383, #370, #236, #375)
- **prosecute:** correct trust-root tiering for the sharded ticket store; wire the
  P5→P7 finding bridge into every harness (#319, #322, #323)
- **tickets:** bound the active-ticket pointer and store readers against a hostile
  store; make the migration write a working `.gitignore` (#341, #343, #328)
- **rails-guard:** make the frozen-rail denial state its scope honestly; hermetic
  tests, scoped bypass, in-session observability for rails-bypass (#243, #332, #204, #336)
- **flail-detector / fleet:** collect `file_path` from any container, not a fixed
  key set; make the flail gate actually detect a flail; make a fail-open flail
  consultation observable (#114, #335, #334, #284, #304, #309, #316)
- **mutation-gate / ci:** exclude deleted files from the changed set; classify
  mutation-gate source by include-list, not exclusion; recognize the bot author
  `gh` reports so the drift tracker updates (#329, #330, #289, #265, #266)
- **hollow-test:** a kill must mean the tests ran and failed (#293, #306)
- **tokenomics:** cap unbounded prompt payloads in parallax/fleet (#280, #296)
- **herdr:** keep the ticket visible in the board header, and measure the board in terminal cells (#368)
- **marketing:** head the chain column "At this phase", not "Approver" (#373)
- **adlc-pi:** delete the dead `index.js` carrying the pre-#290 shell classifier (#307, #331)
- **cursor:** stop the packaging test mutating the real `package.json` (#327)

## [1.6.0] - 2026-07-22

A lockstep release rewrites the `version` field in every one of the suite's 34
`package.json` files at once. Any ticket railing a package path — ordinary
practice here — therefore failed rails-guard on *every* release, whether or not
the rail had anything to do with that release. Three consecutive releases hit
this and were unblocked by completing stale tickets, which fixed the symptom
(drift) but not the collision. This release fixes the collision.

### Changed

- **rails-guard: a version-only manifest edit is no longer a rail edit.** The
  guard now requires each side of a changed manifest to be its own canonical
  re-serialisation, then compares by structural path rather than raw text or a
  parsed-JSON walk — the first two approaches were each independently rejected
  under adversarial review for classes of bypass the other didn't cover (parsed
  JSON can't see byte-level or encoding tampering; raw text can't see structure,
  e.g. an npm lifecycle field masquerading as a version bump). A lockstep bump
  now passes cleanly; a real behaviour change hidden inside the same edit still
  fails. (#228, #234)

- **tickets: a rail that would freeze a manifest is now rejected at authoring
  time**, not just exempted at release time. `rails: ["packages/x/**"]` is
  refused with a pointer to the intended form, `packages/x/lib/**` — the
  complementary fix to the above: #234 stops a lockstep bump from tripping an
  existing over-broad rail; this stops the next one from being written.
  (#235, #253)

### Added

- **ci: a diff-scoped mutation-coverage gate.** Runs on every PR touching
  `packages/**` or `plugins/**`; mutates only the changed lines and fails if
  no test notices. Exists because the same failure mode — a guard added
  without a test that would catch its own removal — recurred five times
  across the two fixes above alone, three of which were caught only by an
  external reviewer rather than the test suite. (#251)

### Fixed

- **rails-guard: a rail edit could be staged, then reverted in the working
  tree, and evade the freeze gate entirely.** The changed-file set was
  computed from a working-tree-only diff, so a violation that made it into the
  index — which is what `git commit` actually records — was invisible to the
  gate if the working copy was restored to baseline afterward. The changed-file
  set is now the union of the working-tree and staged diffs. (#244, #255)

- **core: two files whose names or contents differed only in invalid UTF-8
  bytes could be treated as the same file**, because the byte stream was
  decoded before being split on the raw delimiter — every byte a diff cannot
  decode collapses to the same replacement character. Changed-file discovery
  now fails closed on any path or content it cannot represent losslessly,
  rather than silently aliasing two different files together. (#249, #252)

- **init: `adlc-init` now creates a working ticket store on a fresh repository.**
  Previously the bootstrap command could leave a repo without a ticket store at
  all, so the very first ticket a new user tried to create had nowhere to go.
  (#258)

- **ci: the mutation-coverage gate above was mutating entire touched files
  instead of just the changed lines**, so a PR could be blocked by
  pre-existing gaps in code it never touched. Fixed to hunk-scope from the
  diff directly, with a bounded, environment-safe fallback for files outside
  the fast path. (#251, #260)

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
