# Spec: ADLC v0.3 Modernization — Theory, Core Consolidation, Plugin Bundling & Dogfooding Convergence

**Phase:** P1 Interrogate / P2 Decompose · **Status:** READY FOR P1 APPROVAL · **Revision:** v1
**Date:** 2026-10-16

---

## 1. Problem

A repository-wide audit of `adlc` (34 workspace packages, 8 harness/operating-model plugins, 45 repo scripts, and `ADLC.md`) identified four classes of defects and structural debt:

1. **Theory vs. Practice Divergence in `ADLC.md`:**
   - Cross-model review is demoted in `ADLC.md` (§2 Principle 3, §3 P5, §4 Norms Rejected) as an optional "third-order bonus," whereas ADRs 0007 and 0012 proved same-family P5 shares the builder's training blind spots on security deny-paths (~17 bypasses caught only by a second model family).
   - Adversarial review is restricted to P5 in `ADLC.md`, whereas ADRs 0005 and 0008 expanded it to P1→P2 (`design-review` for trust boundaries), P3 (rail adequacy), P5 (diff prosecution), and P6.
   - Token quotas are blanket-rejected in `ADLC.md` §4, whereas `@adlc/autopilot` (ADR 0016) and `@adlc/quartermaster` enforce a 50% OAuth subscription start-gate (`five_hour < 50 && seven_day < 50`) and multi-channel supply routing.
   - Five emergent failure modes (**F9** in-band reviewer authority-smuggling, **F10** same-family blind-spot sharing & causal-path vacuity, **F11** cross-ticket horizontal drift, **F12** fail-open lookalike-grammar bias, **F13** compaction amnesia & fix-loop oscillation), three exploits (**E6** cross-family prior independence, **E7** calibrated fast decision heads, **E8** horizontal release audits), the D0 decomposition-compiler clause, the gate failure-policy table, and the 5-layer operating stack (`adlc-herdr` → `autopilot` → `quartermaster` → `fleet` → 7 harness plugins) are missing from `ADLC.md`.

2. **Confirmed Production Bugs & Cross-Plugin Security Drift:**
   - **Windows `D:\D:\...` path corruption:** `segmentsOf(p)` in `packages/core/lib/railpath.mjs:18-20` fails to strip `parse(p).root` before splitting, turning `D:\a\file.js` into `D:\D:\a\file.js`; `packages/merge-forecast/lib/signals.mjs:48,89` uses `resolved.startsWith(root + '/')` on backslash paths, zeroing out import-graph conflict signals on Windows.
   - **P5→P6 Revision Identity Mismatch (`git-change:` vs `git-worktree:`):** `packages/prosecute/lib/run.mjs:73-76` records `p5-complete` with `resolveChangeSetRevision` (`git-change:<baseSha>:<digest>`), while `packages/runner/lib/assertions.mjs:618-620` and `packages/runner/lib/acceptance.mjs:213` check `resolveRevision` (`git-worktree:<digest>`), rejecting valid P5 evidence as stale when `--revision` is omitted.
   - **`@adlc/review-calibration` Target Filter Bug:** `packages/review-calibration/lib/targets.mjs:9-10` uses unanchored `EXCLUDE_PATH_RE = /(?:test|spec)/i`, silently skipping production files in `packages/hollow-test/`, `packages/spec-lint/`, `packages/gate-manifest/lib/attest.mjs`, etc., and treats extensionless files (`LICENSE`, `CODEOWNERS`) as JS code.
   - **`@adlc/gate-fuzzing` Witness & Seatbelt Bugs:** `packages/gate-fuzzing/lib/witness.mjs:32,65-75` misclassifies `r.status === null` (`ENOENT`) as a timeout and fails to reject shell launch exit codes `126`/`127`; `packages/gate-fuzzing/lib/sandbox.mjs:52` interpolates `${cloneDir}` into a macOS Seatbelt profile without escaping `"` or `\`.
   - **`@adlc/parallax` Missing `usageStatus`:** `packages/parallax/lib/verdict.mjs:53-59` omits `usageStatus: 'unreported'` on `--record-verdict`, hiding prompt-only `parallax` runs from `adlc spend`.
   - **Missing F9 Prompt-Injection Inoculation in 3 Harnesses + `packages/init`:** `prosecutor-verifier` in `plugins/adlc-gemini`, `plugins/adlc-codex`, `plugins/adlc-copilot`, and `CODEX_AGENT_TEMPLATES` in `packages/init/lib/scaffold.mjs` lack the untrusted-data inoculation paragraph present in `claude-code`, `cursor`, and `opencode`.

3. **Core Layer Inversion, Primitive Duplication & Dormant Hook Bloat:**
   - `@adlc/core` imports `@adlc/tickets` in 2 files, forcing 759 lines of `gate-manifest` primitives into `@adlc/tickets` and a 334-line re-implementation of the manifest writer in `packages/tickets/lib/evidence.mjs`.
   - `writeFileAtomic` is implemented 9 times, directory locks + PID-reuse probes 7 times (`core/lib/ledger.mjs` lacks `owner.json` recovery), `canonicalJson` 5 times, secret scanners 4 times, and P5/P6 verification helpers 3 times across `prosecute` and `runner`.
   - `@adlc/context-handoff` and `@adlc/build-gate` export `HARD_BYTES = 256 * 1024` (256 KiB) as the library default despite `bin/build-gate.mjs` overriding it to 8 MiB after 256 KiB locked out live sessions (#966), and ~4,500 lines of disconnected handoff hook adapters remain across `claude-code`, `codex`, `opencode`, and `pi`.

4. **Plugin Duplication (~30,000+ LOC) & `scripts/` Split-Brain (~32,300 LOC):**
   - Standalone plugins (`claude-code`, `codex`, `copilot`, `gemini`) inline-fork ~12,000 lines of `@adlc/*` logic instead of using `esbuild` bundling (already proven in `scripts/build-cursor-mcp.mjs`).
   - `scripts/` holds repo-only gates (`mutation-gate.mjs`, `ceremony-drift.mjs`, `check-reviewer-directed-comments.mjs`, `guard-findings-ledger-append-only.mjs`, `scan-findings-ledger.mjs`, `rails-guard-ci.mjs`) and 3,109 lines of `rails-guard` tests that belong in shipped `@adlc/*` packages.

---

## 2. Settled Architectural Decisions (P1)

1. **Plugin Hook & MCP Bundling Strategy:** Generalize the `esbuild` bundler pattern (`scripts/build-cursor-mcp.mjs`) so standalone plugin hooks and `.mcp.json` servers in `claude-code`, `codex`, `copilot`, `gemini`, and `cursor` bundle canonical `@adlc/*` packages from source rather than maintaining inline forks or expanding `scripts/ticket-readers/generate.mjs`.
2. **Context-Handoff Slimming & Threshold Alignment:** Strip the ~4,500 lines of disconnected plugin hook adapters (`handoff-gate.mjs` / `handoff-resolve.mjs` in `claude-code`, `codex`, `opencode`, `pi`), update `HARD_BYTES` to `8 * 1024 * 1024` (8 MiB) in `@adlc/context-handoff` and `@adlc/build-gate`, and retain `@adlc/context-handoff` as a lean operator CLI and band library.
3. **Phased Execution via Antigravity Booster (`agb`):** Execute **Wave 1** (High-Severity Bug & Security Drift Fixes) and **Wave 2** (`ADLC.md` v0.3 Doctrine Update, `@adlc/core` Primitive Promotion & Context-Handoff Slimming) first as disjoint-scope `plan.json` DAGs, followed by Waves 3–5.

---

## 3. Wave Decomposition & Ticket Architecture

### Wave 1: High-Severity Bug & Security Drift Fixes (7 Parallel Disjoint-Scope Tickets)

| Ticket ID | Scope | Rails | Summary |
| --- | --- | --- | --- |
| `W1-T1` | `packages/core/lib/railpath.mjs`, `packages/core/test/railpath.test.mjs` | `packages/core/index.mjs` | Strip `parse(p).root` in `segmentsOf(p)` before splitting so Windows drive roots (`D:\`) and absolute symlink targets never duplicate into `D:\D:`. |
| `W1-T2` | `packages/merge-forecast/lib/signals.mjs`, `packages/merge-forecast/test/signals.test.mjs` | `packages/merge-forecast/bin/merge-forecast.mjs` | Normalize Windows backslashes to `/` in `walkTree` and `resolveSpecifier` so import-graph proximity signals work on Windows. |
| `W1-T3` | `packages/runner/lib/assertions.mjs`, `packages/runner/lib/acceptance.mjs`, `packages/runner/test/**` | `packages/prosecute/lib/run.mjs` | Support `git-change:<baseSha>:<digest>` revisions recorded by `adlc prosecute` in `assertPhase` (`p5`/`p6`) and `recordAcceptancePacket` when `--revision` is omitted. |
| `W1-T4` | `packages/review-calibration/lib/targets.mjs`, `packages/review-calibration/test/**` | `packages/hollow-test/lib/targets.mjs` | Replace unanchored `EXCLUDE_PATH_RE = /(?:test\|spec)/i` and negative `EXCLUDE_EXT_RE` with anchored `TEST_PATH_RE` and positive `CODE_EXT_RE` ported from `hollow-test`. |
| `W1-T5` | `packages/gate-fuzzing/lib/witness.mjs`, `packages/gate-fuzzing/lib/sandbox.mjs`, `packages/gate-fuzzing/test/**` | `packages/review-calibration/lib/verify.mjs` | Separate `r.error` (`ENOENT`/`EACCES`) from `timedOut` in `runWitness`, reject shell exit codes `126` and `127`, and escape `\` and `"` in macOS Seatbelt `(subpath "...")` profiles. |
| `W1-T6` | `packages/parallax/lib/verdict.mjs`, `packages/parallax/test/**` | `packages/coldstart/lib/verdict.mjs` | Add `usageStatus: 'unreported'` to `recordVerdict` in `@adlc/parallax` so `--record-verdict` entries are counted by `adlc spend`. |
| `W1-T7` | `plugins/adlc-gemini/agents/**`, `plugins/adlc-codex/agents/**`, `plugins/adlc-copilot/agents/**`, `packages/init/lib/scaffold.mjs`, `packages/init/test/**` | `plugins/adlc-claude-code/agents/prosecutor-verifier.md` | Add the mandatory F9 untrusted-data prompt-injection inoculation clause to `prosecutor-verifier` in Gemini, Codex, Copilot, and `packages/init` `CODEX_AGENT_TEMPLATES`, and fix Gemini's lens schema instruction. |

### Wave 2: `ADLC.md` v0.3 Doctrine, `@adlc/core` Primitive Promotion & Context-Handoff Slimming (4 Tickets)

| Ticket ID | Scope | Edges | Summary |
| --- | --- | --- | --- |
| `W2-T1` | `ADLC.md`, `docs/models-by-phase.md`, `docs/toolkit.md` | — | Update `ADLC.md` to v0.3: add F9–F13 and E6–E8, promote 2-family cross-model quorum on trust-root surfaces (with gateway discounting), add P1/P3/P5/P6 adversarial coverage map, refine §4 token quotas for 50% start-gates (`quartermaster`/`autopilot`), add D0 compiler clause, add gate failure-policy table, and document the 5-layer operating stack (`herdr`/`autopilot`/`quartermaster`/`fleet`/plugins) and sharded/segmented stores. |
| `W2-T2` | `packages/core/lib/**`, `packages/core/index.mjs`, `packages/core/index.d.ts`, `packages/core/test/**` | `to: W2-T3` | Promote canonical `writeFileAtomic` (`wx` + `fsync` + symlink-safe), `acquireDirLock` (`owner.json` + `/proc/<pid>/stat` starttime PID-reuse check, upgrading `withLedgerLock`), `redactSecrets`, and `recordPromptOnlyVerdict` into `@adlc/core`. |
| `W2-T3` | `packages/context-handoff/**`, `packages/build-gate/**` | `to: W2-T4` | Unify `HARD_BYTES = 8 * 1024 * 1024` (8 MiB) across `@adlc/context-handoff` (`lib/thresholds.mjs`) and `@adlc/build-gate` (`lib/depth-signal.mjs`), passing explicit `bytesThreshold` overrides in unit tests that use small synthetic transcripts. |
| `W2-T4` | `plugins/adlc-claude-code/hooks/**`, `plugins/adlc-codex/hooks/**`, `plugins/adlc-opencode/lib/**`, `plugins/adlc-pi/lib/**`, `plugins/adlc-copilot/hooks/**`, `packages/context-handoff/test/**` | — | Remove disconnected `handoff-gate.mjs` / `handoff-resolve.mjs` dead hook forks from `claude-code` and `codex` (and corresponding `*-helper-drift.test.mjs` files), slim `opencode`/`pi` handoff wrappers, and unwire inert `adlc-build-gate.mjs` from `adlc-copilot/hooks/hooks.json`. |

### Waves 3–5 Roadmap (Subsequent `agb` Campaigns)

- **Wave 3 (Layer-Inversion & Package Deduplication):**
  - `W3-T1`: Move manifest primitives to `@adlc/core`, remove `@adlc/core` → `@adlc/tickets` dependency cycle, and delete the duplicate 334-line manifest writer in `packages/tickets/lib/evidence.mjs`.
  - `W3-T2`: Deduplicate the ~200 LOC of P5/P6 transcript/packet/finding verification helpers across `@adlc/prosecute` and `@adlc/runner`.
  - `W3-T3`: Unify the Jaccard + union-find + LLM clustering engine shared by `@adlc/lesson-foundry` and `@adlc/rejection-mining`.
  - `W3-T4`: Refactor `@adlc/autopilot` to import `spawnAsync`, `git-mirror`, `lock`, and `block` from `@adlc/core` / `@adlc/fleet` / `@adlc/ticket-sync`.
- **Wave 4 (Dogfooding Gate Promotion `scripts/` → `packages/`):**
  - `W4-T1`: Promote deleted-file filtering (#329), baseline timing probes (#913), adaptive mutant budgets (#531), and test-target mapping from `scripts/mutation-gate.mjs` into `@adlc/hollow-test`.
  - `W4-T2`: Promote `scripts/ceremony-drift.mjs` into `@adlc/tickets` (`adlc ticket prune --github-issue`) and unblock contract-preserving `.adlc/tickets/` → `.adlc/ticket-archive/` moves in `packages/rails-guard/lib/ci/rail-freeze.mjs`.
  - `W4-T3`: Promote `check-reviewer-directed-comments.mjs`, `guard-findings-ledger-append-only.mjs`, and `scan-findings-ledger.mjs` into `@adlc/rails-guard` (`adlc rails-guard-ci`), read repo `trustRoots` from `.adlc/config.json`, and move `scripts/test/rails-guard-*.test.mjs` into `packages/rails-guard/test/`.
- **Wave 5 (Plugin Hook `esbuild` Bundling & Ceremony/Prosecutor Codegen):**
  - `W5-T1`: Generalize `scripts/build-cursor-mcp.mjs` into `scripts/build-plugin-bundles.mjs` to bundle standalone hook and MCP entrypoints for `claude-code`, `codex`, `copilot`, `gemini`, and `cursor` from `@adlc/*` source, and wire `adlc-herdr` to the bundled read-only ticket loader.
  - `W5-T2`: Centralize the 5 prosecutor lens prompts + verifier prompt in `@adlc/prosecute` and generate all 44 plugin agent files + ceremony skills/commands via `scripts/router/gen-routers.mjs`.

---

## 4. Acceptance Criteria

1. **Windows drive-root stripping in `@adlc/core`:** `resolveRailPath` and `segmentsOf` in `packages/core/lib/railpath.mjs` strip both `parse(p).root` and Windows drive prefixes (`/^[A-Za-z]:[\\/]?/`) before splitting so Windows absolute paths and symlink targets (`D:\repo\src\a.mjs`) never produce `D:\D:` segments on any host OS. Verify: `node --test packages/core/test/railpath.test.mjs`
2. **Windows import-graph path normalization in `@adlc/merge-forecast`:** `walkTree` and `resolveSpecifier` in `packages/merge-forecast/lib/signals.mjs` normalize backslash separators to `/` before prefix and relative-path checks. Verify: `node --test packages/merge-forecast/test/*.test.mjs`
3. **Change-set revision compatibility in `@adlc/runner`:** `assertPhase` (`p5` and `p6`) in `packages/runner/lib/assertions.mjs` and `recordAcceptancePacket` in `packages/runner/lib/acceptance.mjs` extract `<baseSha>` from recorded `git-change:<baseSha>:<digest>` revisions and resolve via `resolveChangeSetRevision` when `--revision` is omitted. Verify: `node --test packages/runner/test/*.test.mjs`
4. **Anchored test-path and code-extension filtering in `@adlc/review-calibration`:** `filterCodeFiles` in `packages/review-calibration/lib/targets.mjs` uses anchored `TEST_PATH_RE` and positive `CODE_EXT_RE` so production files under `packages/hollow-test/` or `packages/spec-lint/` are retained while test files and extensionless non-code files (`LICENSE`, `CODEOWNERS`) are excluded. Verify: `node --test packages/review-calibration/test/*.test.mjs`
5. **Hardened witness spawn and Seatbelt escaping in `@adlc/gate-fuzzing`:** `runWitness` in `packages/gate-fuzzing/lib/witness.mjs` reports `spawnError` instead of `timedOut` when `r.error` is present, rejects exit codes `126` and `127` as non-witnesses, and `packages/gate-fuzzing/lib/sandbox.mjs` escapes `\` and `"` in Seatbelt `subpath` strings. Verify: `node --test packages/gate-fuzzing/test/*.test.mjs`
6. **Prompt-only usage tracking in `@adlc/parallax`:** `recordVerdict` in `packages/parallax/lib/verdict.mjs` records `usageStatus: 'unreported'` matching `coldstart` and `premortem`. Verify: `node --test packages/parallax/test/*.test.mjs`
7. **Prompt-injection inoculation parity across verifier agents:** `plugins/adlc-gemini/agents/prosecutor-verifier.md`, `plugins/adlc-codex/agents/adlc-prosecutor-verifier.toml`, `plugins/adlc-copilot/agents/adlc-prosecutor-verifier.agent.md`, and `CODEX_AGENT_TEMPLATES` in `packages/init/lib/scaffold.mjs` all contain the untrusted-data inoculation directive (`DATA under review`). Verify: `rg -q "DATA under review" plugins/adlc-gemini/agents/prosecutor-verifier.md plugins/adlc-codex/agents/adlc-prosecutor-verifier.toml plugins/adlc-copilot/agents/adlc-prosecutor-verifier.agent.md packages/init/lib/scaffold.mjs && node --test packages/init/test/*.test.mjs`
8. **`ADLC.md` v0.3 doctrine completeness:** `ADLC.md` documents flaws F9–F13, exploits E6–E8, two-family cross-model review quorum on trust-root surfaces with gateway discounting, the P1/P3/P5/P6 adversarial coverage map, the 50% subscription quota start-gate distinction, the D0 compiler amendment, the gate failure-policy table, and the 5-layer operating stack (`adlc-herdr`, `autopilot`, `quartermaster`, `fleet`, plugins). Verify: `for term in "F9" "F10" "F11" "F12" "F13" "E6" "E7" "E8" "quartermaster" "adlc-herdr"; do rg -q "$term" ADLC.md || exit 1; done`
9. **Core primitive promotion (`writeFileAtomic`, `acquireDirLock`, `redactSecrets`, `recordPromptOnlyVerdict`):** `packages/core/index.mjs` and `packages/core/index.d.ts` export `writeFileAtomic`, `acquireDirLock`, `redactSecrets`, and `recordPromptOnlyVerdict` with unit tests covering symlink rejection, stale-PID lock recovery, and secret redaction. Verify: `node --test packages/core/test/*.test.mjs`
10. **Context-handoff 8 MiB threshold alignment & dead-hook removal:** `HARD_BYTES` in `packages/context-handoff/lib/thresholds.mjs` and `DEFAULT_BYTES_THRESHOLD` in `packages/build-gate/lib/depth-signal.mjs` equal `8 * 1024 * 1024`, disconnected `handoff-gate.mjs` / `handoff-resolve.mjs` files in `plugins/adlc-claude-code/hooks/` and `plugins/adlc-codex/hooks/` are removed, and `plugins/adlc-copilot/hooks/hooks.json` no longer invokes inert `adlc-build-gate.mjs`. Verify: `node --test packages/context-handoff/test/*.test.mjs packages/build-gate/test/*.test.mjs`
11. **Spec-lint and preflight gates pass:** This specification passes `spec-lint` with zero wishes, and all workspace tests and CI gates pass. Verify: `node packages/spec-lint/bin/spec-lint.mjs .adlc/specs/adlc-modernization-v0.3.md && npm run preflight`

---

## 5. Premortem: Failure Causes Folded In

| # | Failure Cause | How the Spec & Ticket DAG Mitigate It |
| --- | --- | --- |
| 1 | `node:path` on Linux treats `'D:\\a\\file.js'` as a relative path (`parse(p).root === ''`), so testing `segmentsOf('D:\\a\\file.js')` on Linux misses the Windows drive-root bug | `W1-T1` strips both `parse(p).root` and leading Windows drive prefixes `/^[A-Za-z]:[\\/]?/` in `segmentsOf(p)`, and exports `segmentsOf` for cross-OS unit testing (AC 1). |
| 2 | `assertPhase('p5')` and `recordAcceptancePacket` do not accept a `--base` CLI flag, so calling `resolveChangeSetRevision` without knowing the base ref fails | `W1-T3` parses `<baseSha>` directly from the recorded `git-change:<baseSha>:<digest>` revision string on `assertedP5Entry` and passes `base: baseSha` to `resolveChangeSetRevision` (AC 3). |
| 3 | Raising `HARD_BYTES` from `256 KiB` to `8 MiB` in `thresholds.mjs` breaks existing unit tests in `context-handoff` and `build-gate` that use ~300 KB synthetic transcripts | `W2-T3` updates unit tests that test byte-threshold tripping to pass an explicit `bytesThreshold` override while adding a dedicated test asserting the default constant is `8 * 1024 * 1024` (AC 10). |
| 4 | Deleting `handoff-resolve.mjs` from `plugins/adlc-{claude-code,codex}/hooks/` breaks `packages/context-handoff/test/{cc,codex}-helper-drift.test.mjs` | `W2-T4` sequences after `W2-T3` via an explicit DAG edge and includes `packages/context-handoff/test/**` in its scope to remove the obsolete helper-drift tests alongside the deleted hook copies (AC 10). |
| 5 | Editing `scripts/router/router-model.mjs` without regenerating all 6 router targets trips `router-drift.yml` in CI | `W2-T1` scopes strictly to `ADLC.md`, `docs/models-by-phase.md`, and `docs/toolkit.md`; router codegen changes are isolated to Wave 5 (`W5-T2`). |

