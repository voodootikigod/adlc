# Spec — Codex-native ADLC integration flush

**Phase:** P1 contract for the Codex native integration roadmap.

## Problem

The repository contains a valid Codex plugin skeleton, but the supported user path is
split between a translated Claude-compatible plugin and the actual `adlc-codex`
plugin. The translated hook expands a non-Codex `CODEX_PLUGIN_ROOT` variable and exits
1, the public install guide describes a smoke test rather than an install, rail
enforcement depends on a shell export that cannot persist into Codex, and neither CI
nor the marketing examples execute the contract they advertise.

## Deliverables

1. Make `plugins/adlc-codex` a publish-ready `@adlc/codex` plugin with a rich Codex
   manifest, lockstep release versioning, skill interface metadata, a first-class
   `$adlc-init` skill, and project-local ADLC subagent templates.
2. Add deterministic `adlc init` scaffolding for `.adlc/` and Codex project-agent
   configuration. It must be idempotent, preserve existing files, and never write to
   user-global Codex state.
3. Auto-arm the native rail hook from a selected `.adlc/current-ticket.json` whose
   ticket declares rails. Preserve explicit environment overrides and fail closed on
   conflicting or stale ticket selection.
4. Add advisory lifecycle hooks for session/compaction/subagent continuity and stop
   evidence verification. Advisory hook failures must not produce a non-zero hook
   exit. Keep `PreToolUse` as the only in-session deny hook and document CI as the
   enforcement backstop.
5. Add a plugin-declared, zero-shell MCP stdio server exposing allowlisted ADLC gate and
   prosecution tools through the stable `adlc mcp-server` entrypoint. Keep the plugin
   wrapper as an npm-compatible delegate to the same implementation. Validate every
   argument and use `execFile`, never a shell. The installed Codex plugin must launch
   the server without relying on shell or hook-only `${PLUGIN_ROOT}` interpolation, and
   the server must retain the active repository as its working directory.
6. Repair the Codex install smoke test: canonicalize macOS paths, clean all temporary
   homes on every exit, validate the package/MCP/agent/init surfaces, and exercise a
   real isolated Codex marketplace install when enabled.
7. Add required pinned Codex CI coverage plus an advisory latest-version canary. Add
   executable documentation tests that reject invented CLI examples and stale install
   claims.
8. Replace the Fumadocs, Markdown, and marketing Codex installation story with the
   npm CLI plus Git marketplace path. Require `@adlc/cli` 1.4.2 or newer, keep CLI and
   plugin upgrades coupled, and document initialization, new-thread pickup, inspection,
   uninstall, hook trust, and the translated-plugin recovery path. Correct the homepage
   gate commands and qualify machine-checkability claims.
9. Remove volatile "powers Codex" model assertions and label the model table as a
   dated, directional snapshot with primary-source verification required.
10. Make the umbrella installation complete for every advertised toolkit package, or
    stop advertising a directory without a publishable package contract.

## Acceptance criteria

- **AC1 — init:** `node --test packages/init/test/*.test.mjs` proves fresh and
  idempotent scaffolding, preservation of existing config, and no writes outside the
  supplied root, including through repository-controlled symlinks.
  `node packages/cli/bin/adlc.mjs init --root <tmp> --json` exits 0.
- **AC2 — rails:** native hook tests prove automatic activation from
  `current-ticket.json`, explicit off/on overrides, stale/conflicting ticket failure,
  rail denial, and a no-op for repositories with no selected ticket. Verify with
  `node --test plugins/adlc-codex/hooks/test/*.test.mjs`.
- **AC3 — lifecycle:** native hook tests prove session/compact/subagent context output
  and that advisory preflight/flail/manifest failures exit 0 with visible warnings.
  Verify with `node --test plugins/adlc-codex/hooks/test/*.test.mjs`.
- **AC4 — MCP:** a protocol test initializes the real stdio server, lists the ADLC
  tools, rejects unallowlisted commands/arguments and symlink escapes, bounds subprocess
  time/output, and executes an injected safe gate without shell interpolation. Verify with
  `node --test plugins/adlc-codex/mcp/test/*.test.mjs`. The installed-plugin smoke must
  additionally make Codex itself start the registered MCP transport and complete an
  `initialize` plus `tools/list` exchange. The smoke must fail if Codex receives an
  unresolved `${PLUGIN_ROOT}` argument; test-only placeholder replacement is forbidden.
- **AC5 — package/release:** `npm pack --dry-run` for `plugins/adlc-codex` contains the
  manifest, skills, hooks, MCP server, and agent templates; release tests prove the
  Codex manifest and package remain in lockstep with the suite version.
- **AC6 — install:** offline and live isolated Codex smoke paths clean up their temp
  state even after partial setup failure; the live path accepts `/private/var`
  canonicalization on macOS and proves the installed plugin exposes skills, hooks, MCP
  configuration, rail denial, and failure-isolated advisory hooks. Verify with
  `node scripts/codex-install-smoke.mjs .` and
  `ADLC_CODEX_LIVE_INSTALL=1 node scripts/codex-install-smoke.mjs .`.
- **AC7 — docs truth:** docs tests execute or parse every homepage command against the
  CLI help contract and reject the phrases claiming Git marketplace installation is
  unsupported. Marketing, Fumadocs, and the canonical Markdown guide show the same
  npm-first install and coupled CLI/plugin update sequence without requiring a checkout.
  Verify with `node --test apps/docs/test/*.test.mjs`.
- **AC8 — CI:** root tests include the Codex hook/MCP/init/smoke suites, and CI has a
  pinned required Codex proof plus an advisory latest Codex proof. Verify with
  `node --test scripts/test/codex-ci-contract.test.mjs`.
- **AC9 — regression:** `npm test`, docs type-check/build where available, the offline
  Codex smoke, and `adlc rails-guard --base main --ticket T46` pass. No user-global
  `~/.codex` state is mutated by tests.

## Boundaries

- Publishing to npm and changing the user's active `~/.codex` installation require
  external authority and are not performed by this implementation. The repository
  will be release-ready and will document the exact user commands.
- Hook protection remains defense in depth; the required diff-based CI rail gate is
  the authoritative enforcement layer.
- Existing unrelated integration behavior and completed ticket artifacts are not
  rewritten.

## Premortem defenses

- **A translated compatibility install keeps winning discovery.** The docs name the
  exact native plugin id (`adlc-codex@adlc`), include removal of `adlc@plugins-cli`, and
  the isolated smoke asserts the installed id and `PLUGIN_ROOT` hook command.
- **Automatic rail activation blocks non-build work forever.** Selection alone is not
  enough: the chosen ticket must declare rails, an explicit `ADLC_P4_ENFORCEMENT=0`
  remains a deliberate local override, and completed tickets do not activate.
- **Advisory hooks recreate the exit-1 noise.** Every advisory mode has a top-level
  catch, emits structured context/warnings, and is tested to exit 0 when its delegated
  command is missing or fails.
- **The MCP server becomes arbitrary command execution.** Tool names map to a closed
  gate allowlist, arguments reject control characters, option injection, and real-path
  escapes, and all execution uses bounded `execFile` calls with `shell: false`.
- **An npm-ready package works only from a checkout.** Package contents are asserted by
  `npm pack --dry-run`; the smoke installs from the marketplace into an isolated
  `CODEX_HOME` and inspects the cached payload rather than the source tree.
- **The MCP protocol passes while the Codex launcher is broken.** The isolated smoke
  starts the transport through Codex's registered configuration, not a separately
  rewritten command. Plugin-root discovery and repository working-directory behavior
  are tested independently so fixing the entrypoint cannot redirect ADLC gates into the
  installed plugin cache.
- **Release automation leaves the plugin cache pinned to an old version.** The release
  drift gate reads both `package.json` and `.codex-plugin/plugin.json` and fails if
  either differs from the suite version.
- **Documentation tests bless invented examples again.** Homepage commands live in an
  exported data module and are checked against real CLI `--help` contracts rather than
  only asserted non-empty.
- **CI latest drift either bricks all merges or stays invisible.** A pinned Codex lane
  is required; the latest-version lane is separate and advisory, matching the existing
  OpenCode drift-canary pattern.
- **A project scaffold follows a malicious repository symlink.** Initialization
  canonicalizes its root, rejects symlink components for every destination before the
  first write, and tests that no outside directory is created.
- **A partial live-smoke setup leaks disposable homes.** Temporary roots are registered
  for cleanup immediately after allocation; an injected setup failure proves the set is
  unchanged afterward.
