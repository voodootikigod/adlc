# Adversarial Codebase Audit & Enhancement Report: ADLC Toolkit (`v1.13.0`)

- **Target Baseline:** `09cae8d82beeb8feb3400cefe6cdc22c7c939424` (`fix/phase0-security-trust-roots`, PR #1402 on top of `main` `1d0ba375`)
- **Surface Audited:** 35 `@adlc/*` workspace packages + `apps/docs`, 7 agent-harness plugins (`adlc-claude-code`, `adlc-codex`, `adlc-copilot`, `adlc-cursor`, `adlc-gemini` [Antigravity `agy` & JetSki `jetski`], `adlc-opencode`, `adlc-pi`) + `adlc-herdr` TUI board plugin (`8` plugin packages under `plugins/`), CI/CD workflows (`.github/workflows/*`), repository enforcement scripts (`scripts/*`), ADRs (`docs/adr/*`), and `.adlc/` state/specs.
- **Companion Executable Resolution Plan:** [`.adlc/specs/enhancement-resolution-plan.md`](./.adlc/specs/enhancement-resolution-plan.md)

> [!IMPORTANT]
> **Disclosure & Unpushed-Worktree Policy:** All findings below are documented strictly as defensive code-invariant gaps (`file:line` + contract boundary) with zero weaponized exploit payloads. Both planning files remain uncommitted in `.worktrees/adlc-enhancement-plan` for human review; keep branch `docs/adlc-enhancement-plan` unpushed (local-only) until all 4 Wave-1 CRITICAL regression suites (`packages/core/test/git-no-renames.test.mjs`, `packages/core/test/shell-classifiers.test.mjs`, `packages/fleet/test/mirror-symlink-escape.test.mjs`, `packages/review-calibration/test/sandbox-containment.test.mjs`) exist on `origin/main` (mechanically enforced on PRs by `C-T01`).

---

## Executive Summary

ADLC (`v1.13.0`, `package.json:5`) implements a multi-harness agentic software engineering lifecycle: sharded Git-native ticket contracts (`@adlc/tickets`), segmented HMAC-signed evidence forests (`@adlc/gate-manifest`), rail-freeze and trust-root authorization (`@adlc/rails-guard`), diff-scoped mutation testing (`@adlc/hollow-test`), multi-lens and cross-model prosecution (`@adlc/prosecute`), sandboxed parallel worktree orchestration (`@adlc/fleet`, `@adlc/autopilot`), and P7 continuous calibration and lesson extraction (`@adlc/lesson-foundry`, `@adlc/review-calibration`, `@adlc/rejection-mining`, `@adlc/skill-rot`, `@adlc/model-ratchet`).

An adversarial, source-grounded inspection of the post-PR-#1402 baseline identified **27 primary architectural and security defects** (`S1–S15`, `R1–R7`, `P1–P5`), **9 cross-package duplication clusters** (`C1–C9`), and **5 disconnected closed-loop feedback pipelines** (`L1–L5`):

1. **Trust-Root, Sandbox & Hook Bypasses (`Part I`, `S1–S15`):**
   - `git diff` rename detection (`S1`) hides deleted source rail paths on `git mv` with `<50%` edits.
   - Required `mutation-gate` CI (`S2`) executes bare `npm ci` without `--ignore-scripts` while `ticket-store-platform.yml:27` and live-canary jobs (`ci.yml:178,210`) run bare `npm install`, and nested workspace `package.json` files outside tiered prefixes escape `TRUST_ROOT_FILES`.
   - Fleet's worker-writable bare git mirror (`S3`) permits symlinked reflogs/alternates and echoes raw git read errors (`ADLC_MANIFEST_KEY` exfiltration vector) into Strike-2 prompts.
   - `review-calibration` (`S4`) executes `--plants-file` shell witnesses unsandboxed on the host with full `process.env` (`ADLC_MANIFEST_KEY`) and no command allowlist.
   - Marketplace `adlc-cursor` installs (`S5`) lack `node_modules` and wire 8 hook scripts with `failClosed: false`, causing `ERR_MODULE_NOT_FOUND` hook crashes that fail 100% open.
   - Shared shell classifiers (`S6`) omit subshell wrappers (`sh -c`, `bash -c`, `eval`, `exec`, `source`) and inline script flags (`node -e`, `python -c`), while `shellIsPositivelyReadOnly` allows `node --test <untrusted.mjs>`, `rg --pre`, and `git branch -D/-f`, and `plugins/adlc-claude-code` omits in-session `Bash` rail gating (`hooks.json:5`, `adlc-hook.mjs:1156-1171`).
   - `packages/prosecute/lib/tier.mjs` (`S7`) omits all 7 harness plugin enforcement cores, `packages/core/`, `packages/tickets/`, `packages/hollow-test/`, and required CI gate scripts, while `#141` (`readPrContext` at `rail-freeze.mjs:724-728`) drops `review.commit_id` and `enforceTrustRoots` (`rail-freeze.mjs:694-698`) lifts entire trust-root globs on a single-file match.
2. **Orchestration Reliability & Cross-Harness Drift (`Part II`, `R1–R7`):**
   - `autopilot` (`R1`, `R2`) breaks on `fnm`/`nvm`/Homebrew symlinked global npm binaries (`realpathSync` vs `node_modules` check), omits `<prefix>/lib/node_modules/@adlc` and `/bin` in `bwrap`, drops `readOnlyPaths` and `/dev`/`/proc`/`/tmp` in `live-deps.mjs` `READ_POLICY.BOUNDED`, and throws on macOS Seatbelt due to `bwrap`-specific `--chdir` argv splicing in `composeGateArgv` (`gates.mjs:114-124`).
   - Scope overlap (`R3`), lock recovery (`R4`), fleet self-commit/amend handling and `autopilot` skipped-gate CI classification (`R5`), `hollow-test` slow-path script fallback and `mutate.mjs` operator gaps (`R6`), and per-package runtime edge cases (`R7`) degrade unattended execution.
3. **Throughput & Scaling Bottlenecks (`Part III`, `P1–P5`):**
   - 58 serial `spawnSync` barriers in `scripts/run-tests.mjs`, duplicate baseline suite runs before mutant #1 in `mutation-gate`, `O(T^2 * |F|)` synchronous file reads (`.worktrees/` included) in `merge-forecast`, `N+1` `git show` spawns in `GitTreeTicketStore.load()` and `backlog-groom`, and `3x` test/prosecute amplification across `autopilot -> fleet` inflate local and CI latency by `3x–10x`.
4. **Consolidation Debt & Disconnected Compounding Loops (`Parts IV–V`, `C1–C9`, `L1–L5`):**
   - Eight lock implementations, six atomic writers, seven `globMatch` copies, six `canonicalJson` encoders, and three secret-value redaction tables remain split across `@adlc/core`, `@adlc/tickets` (a zero-dependency leaf that `@adlc/core` depends on, preventing upward imports), and consumer packages, while P4->P6->P7 telemetry and lesson artifacts (`flail-detector`, `model-router` priors/budgets, `.adlc/lenses/`, `interrogation-template.md`, `check-*.mjs`, `onUsage`) are emitted by producers without matching live consumers.

---

## Part I: Security, Trust-Root & Containment Vulnerabilities (`S1–S15`)

### S1 `[CRITICAL]` — `git mv` Rename-Detection Bypass Defeats Both Local and CI Rail Guards
- **Locations:**
  - `packages/core/lib/git.mjs:147-150` (`changedFiles`)
  - `packages/rails-guard/bin/rails-guard.mjs:128-129` (`gitDiff`, `coreChangedFiles`)
  - `packages/rails-guard/lib/ci/rail-freeze.mjs:184,637` (`spawnSync` to `bin/rails-guard.mjs`, `enforceTrustRoots`)
- **Code Evidence:**
  - `packages/core/lib/git.mjs:148-149` runs `raw(['diff', '--name-only', '-z', base, '--'])` and `raw(['diff', '--cached', '--name-only', '-z', base, '--'])`.
  - When `diff.renames` is enabled (`true` in user/system git config or Git >= 2.9 defaults on diff commands), `--name-only` on a rename (`R050`–`R100`) emits **only the destination path** and omits the deleted source path unless `--no-renames` is passed.
  - Meanwhile, `enforceTrustRoots` (`packages/rails-guard/lib/ci/rail-freeze.mjs:637-649`) parses both columns of `R100\t<old>\t<new>` **exclusively** for `immutableTrustRoots`, then delegates all active ticket `rails` to `bin/rails-guard.mjs` (`line 184`), which relies on `coreChangedFiles(base)` (`bin/rails-guard.mjs:129`).
- **Architectural Impact & Boundary Gap:**
  - When `diff.renames` is active, renaming a frozen rail file with minor edits causes `coreChangedFiles` to emit only the new destination path and omit the deleted source rail string, allowing rail deletions/renames to go undetected by both `adlc rails-guard` and `scripts/rails-guard-ci.mjs`.
- **Remediation:**
  1. Pass `'--no-renames'` unconditionally to both `diff` invocations in `packages/core/lib/git.mjs:148-149` (hardening both `adlc rails-guard` and `scripts/rails-guard-ci.mjs`) and to `gitDiff` in `packages/rails-guard/bin/rails-guard.mjs:128`.

### S2 `[CRITICAL]` — Arbitrary Code Execution in Required CI Jobs via Unblocked `npm ci` / `npm install` Lifecycle Scripts & Untiered Workspace `package.json`
- **Locations:**
  - `.github/workflows/ci.yml:369` (`mutation-gate` job running bare `npm ci`), `.github/workflows/ci.yml:178,210` (`opencode-live-latest`, `codex-live-latest` running bare `npm install`), and `.github/workflows/ticket-store-platform.yml:27` (`ticket-store-platform` running bare `npm install`)
  - `packages/prosecute/lib/tier.mjs:30-43` (`TRUST_ROOT_FILES`)
  - `scripts/rails-guard-ci.mjs:73` (`REPO_TRUST_ROOTS`)
- **Code Evidence:**
  - `.github/workflows/ci.yml:47-48` (`test` job) runs `npm install --ignore-scripts` followed by `npm rebuild esbuild sharp msgpackr-extract protobufjs @google/genai`, whereas `.github/workflows/ci.yml:369` (`mutation-gate`, a required merge-blocking check per `docs/ci/required-gates.json:9`) runs bare `npm ci` (executing lifecycle scripts), and `.github/workflows/ticket-store-platform.yml:27` plus `.github/workflows/ci.yml:178,210` run bare `npm install` (executing lifecycle scripts **and** ignoring `package-lock.json` immutability).
  - `tier.mjs:35-43` explicitly notes: `"EXACT-match only: a NESTED package.json tiers solely via its package prefix, not this rule"`, and `scripts/rails-guard-ci.mjs:73` freezes only root `'package.json'`.
- **Architectural Impact & Boundary Gap:**
  - Nested workspace `package.json` files outside tiered prefixes fall outside both `REPO_TRUST_ROOTS` (`#141`) and `TRUST_ROOT_FILES` (`tier.mjs`), while jobs invoking npm without `--ignore-scripts` execute untrusted package lifecycle hooks inside CI runners before gate scripts run.
- **Remediation:**
  1. Replace bare `npm ci` at `.github/workflows/ci.yml:369` and bare `npm install` at `.github/workflows/ci.yml:178,210` and `.github/workflows/ticket-store-platform.yml:27` with `npm ci --ignore-scripts` (plus the explicit `npm rebuild` binary allowlist where native addons are needed).
  2. Add `**/package.json` to `tier.mjs` (Wave 1) and `REPO_TRUST_ROOTS` + `CODEOWNERS` (Wave 4 lock-down after workspace dependency cycle changes complete), preserving ADR-0012's `version`-only exemption in `packages/rails-guard/lib/version-only.mjs`.

### S3 `[CRITICAL]` — Fleet Bare-Mirror Sandbox Escape & `ADLC_MANIFEST_KEY` Prompt Exfiltration
- **Locations:**
  - `packages/fleet/lib/live-deps.mjs:563,634-656`
  - `packages/fleet/lib/git-mirror.mjs:43-55,82-116,226-306` (`HOST_SAFE_GIT_FLAGS`, `ALLOWED_MIRROR_CONFIG_KEYS`, `assertMirrorConfigPristine`, `mirrorFetchBack`)
  - `packages/autopilot/lib/gate-repo.mjs:72-100` (`HOST_SAFE_GIT`, `snapshotUntracked`)
- **Code Evidence:**
  - In `bounded` + `mirror` mode (`packages/fleet/lib/live-deps.mjs:563`), `extraWritable` mounts `config.modelPlaneGitMirror` read-write inside the untrusted model container.
  - `assertMirrorConfigPristine` (`packages/fleet/lib/git-mirror.mjs:95-116`) inspects only `join(mirror, 'hooks')` and selected `git config --list` keys — performing **zero recursive `lstatSync` checks** across `refs/`, `packed-refs`, `HEAD`, `logs/`, `info/`, or `objects/info/alternates`, and explicitly permitting `core.logallrefupdates` (`ALLOWED_MIRROR_CONFIG_KEYS` at `git-mirror.mjs:83`).
  - Host-side `worktrees.commitWorker` (`live-deps.mjs:637`) and `mirrorFetchBack` (`live-deps.mjs:642-646`) execute host `git` against that worker-writable directory and interpolate raw `e.message` (`live-deps.mjs:654`) and `fb.detail` (`live-deps.mjs:645`) directly into `output` (which Strike 2 feeds back to the model).
  - Similarly, `packages/autopilot/lib/gate-repo.mjs:97` calls `readFileSync(excludePath)` on `<worktree>/.git/info/exclude` without an `lstatSync` check.
- **Architectural Impact & Boundary Gap:**
  - Host `git` operations executed outside the container against a worker-writable bare mirror follow symlinks, reflog targets, and `alternates` entries in host filesystem context, and unredacted `git` error messages interpolated into retry prompts cross the host-secret boundary.
- **Remediation:**
  1. Add `assertGitDirTreeSafe(mirror)` in `git-mirror.mjs` walking every entry under `mirror` via `lstatSync` (forbidding symlinks, FIFOs, sockets, device nodes, hardlinks `nlink > 1` outside safe packfiles, and banning `objects/info/alternates`, `info/grafts`, and `shallow`).
  2. Remove `core.logallrefupdates` from `ALLOWED_MIRROR_CONFIG_KEYS` and add `'-c', 'core.logallrefupdates=false'` to both `HOST_SAFE_GIT_FLAGS` (`git-mirror.mjs:43-55`) and `HOST_SAFE_GIT` (`gate-repo.mjs:72-80`).
  3. Pass all `commitWorker` / `mirrorFetchBack` error strings through `redactSecrets` (`packages/core/lib/primitives.mjs:164-192`) and sanitize raw ref parse payloads before returning worker feedback.
  4. Use `readBoundedRegularFile` / `lstatSync` regular-file verification before reading `excludePath` in `gate-repo.mjs:97`.

### S4 `[CRITICAL]` — Unsandboxed Host Execution, `ADLC_MANIFEST_KEY` Leakage & Symlink Traversal in `review-calibration`
- **Locations:**
  - `packages/review-calibration/lib/verify.mjs:35-41,136-164` (`runCmd`, `verifyWitness`)
  - `packages/review-calibration/lib/targets.mjs:102-106,149-160` (`loadPlantsFile`)
  - `packages/review-calibration/lib/runner.mjs:46` (`runWithPlants`)
  - `packages/review-calibration/lib/inflight.mjs:88-90` (`writeRecord`)
- **Code Evidence:**
  - Unlike `packages/gate-fuzzing/lib/witness.mjs:22-39` + `packages/gate-fuzzing/lib/loop.mjs` (which runs witnesses in a disposable clone with `buildSandboxPlan`, `sanitizeCandidateEnv`, and `allowedCmds`), `packages/review-calibration/lib/verify.mjs:35-41` spawns `splitCommand(cmd)` directly in the live repo `cwd` with unsanitized `process.env` (`ADLC_MANIFEST_KEY` exposed) and **no `allowedCmds` check**.
  - `loadPlantsFile` (`targets.mjs:149-160`) runs `readFileSync(resolve(cwd, p.file), 'utf8')` before any `resolveTarget` check.
  - `runWithPlants` (`runner.mjs:46`) skips `resolveTarget` whenever `NO_JOURNAL` is set, and `writeRecord` (`packages/review-calibration/lib/inflight.mjs:88-90`) delegates journal writes to `writeInflightAtomic` (which follows symlinks via `realpathSync` for in-repo source mutations) without first asserting `!lstatSync(journalPath).isSymbolicLink()`.
- **Architectural Impact & Boundary Gap:**
  - Witness and review commands in `review-calibration` run directly in the live checkout with inherited host environment variables rather than an isolated clone/sandbox, and symlinked plant or journal targets bypass confinement when `loadPlantsFile`, `NO_JOURNAL`, or `writeRecord` runs.
- **Remediation:**
  1. Promote `gate-fuzzing`'s disposable-clone + `buildSandboxPlan` + `sanitizeCandidateEnv` + `allowedCmds` harness into `@adlc/core` (`packages/core/lib/sandbox-runner.mjs`) and route `review-calibration`'s `verifyWitness` and `--review-cmd` through it.
  2. Call `resolveTarget(cwd, p.file)` + `lstatSync` (`!isSymbolicLink()`) inside `loadPlantsFile`, `verifyWitness`, and `runWithPlants` unconditionally (including under `NO_JOURNAL`).
  3. Assert `!lstatSync(journalPath).isSymbolicLink()` (`O_NOFOLLOW`) on the journal path in `packages/review-calibration/lib/inflight.mjs:88-90` while preserving `writeInflightAtomic`'s `realpathSync` + `{ tempPath }` + mode-preservation contract (`packages/core/lib/inflight.mjs:40-84`) required by `packages/hollow-test/test/inflight.test.mjs:276-337`.

### S5 `[CRITICAL]` — `adlc-cursor` Marketplace Install Fails 100% Open Due to Unbundled `@adlc/*` Imports Across 8 Hook Scripts + `failClosed: false`
- **Locations:**
  - `plugins/adlc-cursor/hooks/hooks.json:1-69` & root mirror `plugins/adlc-cursor/hooks.json:1-69`
  - `plugins/adlc-cursor/hooks/{adlc-session-start,adlc-pretool,adlc-audit,adlc-shell-advisory,adlc-precompact,adlc-subagent,adlc-stop,adlc-preflight}.mjs` (including dynamic `import(spec)` in `adlc-pretool.mjs:97-105` & `adlc-audit.mjs:87,103`)
  - `plugins/adlc-cursor/rails-checker.mjs:12-13` & `plugins/adlc-cursor/lib/workspace-resolve.mjs:5-6`
  - `scripts/build-cursor-mcp.mjs:48-78`, `scripts/cursor-install-smoke.mjs:74-139`, `scripts/mutation-gate.mjs:108-112`, `scripts/test/ticket-store-boundary.test.mjs:50-57,74`
- **Code Evidence:**
  - `scripts/build-cursor-mcp.mjs:5-7` explicitly documents why the Cursor MCP wrapper is bundled: *"Marketplace installs copy `plugins/adlc-cursor/` to `~/.cursor/plugins/cache/.../adlc-cursor/` with **no `node_modules/`**."*
  - Yet both `plugins/adlc-cursor/hooks/hooks.json` and `plugins/adlc-cursor/hooks.json` wire **8 unbundled hook scripts** across 9 lifecycle events (`sessionStart`, `preToolUse`, `afterFileEdit`, `beforeShellExecution`, `preCompact`, `subagentStart`, `subagentStop`, `stop`, `beforeSubmitPrompt`), all configured with `"failClosed": false`. Those hooks import `../rails-checker.mjs`, `../lib/workspace-resolve.mjs`, `@adlc/core`, `@adlc/tickets`, `@adlc/build-gate`, and `@adlc/flail-detector` (and `adlc-pretool.mjs:97-105` + `adlc-audit.mjs:87,103` load `@adlc/build-gate/lib/*.mjs` and `@adlc/flail-detector/lib/signals.mjs` via computed `importModule = (spec) => import(spec)`, which `esbuild` cannot inline unless converted to static literal imports; meanwhile `build-cursor-mcp.mjs:48-51` checks lockstep versions only for `@adlc/core` and `@adlc/tickets`).
- **Architectural Impact & Boundary Gap:**
  - On standalone Cursor Marketplace installations (no `node_modules`), Node aborts at ESM link time (`ERR_MODULE_NOT_FOUND: Cannot find package '@adlc/core'`) before `main()` runs, exiting `1`, which Cursor's `"failClosed": false` (`hooks.json:16`) treats as **allow** — silently disabling P3 rail protection, P4 build-gate enforcement, and session telemetry for 100% of tool calls.
- **Remediation:**
  1. Replace the default computed `(spec) => import(spec)` loader in `adlc-pretool.mjs:97-105` and `adlc-audit.mjs:87,103` with a static literal-specifier map (preserving injectable `importModule` for unit tests), extend `scripts/build-cursor-mcp.mjs` (checking version lockstep across all 4 dependencies in `plugins/adlc-cursor/package.json:58-63`) to esbuild-bundle all **8** Cursor hook entrypoints into self-contained zero-dependency `.bundle.mjs` files, and register them in `scripts/test/ticket-store-boundary.test.mjs` (both `isDirectWriterBypass` at `lines 50-75` and `isPointerParseBypass` at `lines 171-211`) and `GENERATED_VERSION_FILES` (`scripts/mutation-gate.mjs:108-112`).
  2. Set `"failClosed": true` for `preToolUse` in **both** `plugins/adlc-cursor/hooks/hooks.json` and `plugins/adlc-cursor/hooks.json`, updating `scripts/cursor-install-smoke.mjs:128` in lockstep.
  3. Extend `scripts/cursor-install-smoke.mjs` / `scripts/test/cursor-install-smoke.test.mjs` to copy `plugins/adlc-cursor/` to `/tmp` with zero ancestor `node_modules` and assert `preToolUse` enforces both frozen-rail denial and `ADLC_BUILD_GATE_ENFORCEMENT=1`.

### S6 `[CRITICAL]` — Shell Classifier Bypasses in `@adlc/core/lib/shell.mjs` & Missing In-Session `Bash` Rail Gating in `adlc-claude-code`
- **Locations:**
  - `packages/core/lib/shell.mjs:127-132` (`shellHasOpaqueMutation`), `205-219` (`shellIsPositivelyReadOnly`), `222-231` (`shellHasWriteOption`)
  - `plugins/adlc-claude-code/hooks/hooks.json:5` & `plugins/adlc-claude-code/hooks/adlc-hook.mjs:1156-1171` (`rails`)
- **Code Evidence:**
  - `shellHasOpaqueMutation` (`packages/core/lib/shell.mjs:127-132`) checks **only** `git apply|am|checkout|restore|reset|clean|merge|rebase|cherry-pick|stash|commit` and `patch|tar|unzip` — omitting subshell wrappers (`sh`/`bash`/`dash`/`zsh`/`ksh` `-c`, `eval`, `exec`, `source`, `. <script>`) **and** inline script interpreters (`node` `-e`/`-p`/`--eval`/`--print`/`-r`/`--require`/`--import`/`--loader`, `python` / `python3 -c`, `ruby -e`, `perl`, `awk`, `deno eval`, `bun -e`). When an agent passes a benign decoy path alongside an inline interpreter command that computes a rail path dynamically, `mentionedPaths` (`adlc-pretool.mjs:103-112`, `adlc-opencode/rails-checker.mjs:755-764`, `plugins/adlc-pi/lib/rails-checker.mjs:177-182`) resolves only the decoy path and **allows** the rail write.
  - `shellIsPositivelyReadOnly` (`packages/core/lib/shell.mjs:208-219`) matches `readOnlyPrefix` on:
    - `node --test <untrusted-script.mjs>` (executes arbitrary user JS);
    - `rg --pre <binary> pattern file` (`--pre` spawns an arbitrary preprocessor binary per file);
    - `git branch -D main` or `git branch -f <branch>` (`git\s+(?:...|branch|...)\b` at `shell.mjs:208` allows all `git branch` flags unconditionally);
    - `git diff` / `git show` / `git log` without disallowing `GIT_EXTERNAL_DIFF` overrides.
  - Furthermore, `plugins/adlc-claude-code/hooks/hooks.json:5` and `adlc-hook.mjs:1156-1171` match only structured edit tools (`Edit|Write|MultiEdit|NotebookEdit`) — omitting `Bash` in-session rail gating entirely (unlike the other 6 harnesses) and checking `existsSync('.adlc')` (`line 1171`) without walking upward via `enclosingAdlcRoot(process.cwd())`. Because `plugins/adlc-claude-code` has no `package.json` (`scripts/claude-code-plugin-smoke.mjs:398-405` forbids `@adlc/*` imports), `shell.mjs` must be projected into `plugins/adlc-claude-code/hooks/generated-shell.mjs` via `scripts/ticket-readers/generate.mjs` (and later bundled in `T-P21b`).
- **Remediation:**
  1. Treat subshell wrappers (`sh`/`bash`/`dash`/`zsh`/`ksh` `-c`, `eval`, `exec`, `source`, `. <script>`) and inline script interpreter flags (`node` `-e`/`-p`/`--eval`/`--print`/`-r`/`--require`/`--import`/`--loader`, `python* -c`, `ruby -e`, `perl`, `awk`, `lua -e`, `php -r`, `deno eval`, `bun -e`) as opaque mutations in `shellHasOpaqueMutation` (`shell.mjs:127-132`).
  2. Add `--pre` and `--pre-glob` to `shellHasWriteOption` (`shell.mjs:222-231`), restrict `git branch` in `shellIsPositivelyReadOnly` (`shell.mjs:208`) to read-only listing flags (`-l`, `--list`, `-a`, `-r`, `-v`, `--contains`, `--merged`, `--no-merged`, `--show-current`), remove `node --test` from `shellIsPositivelyReadOnly`, and reject leading env assignments (`GIT_EXTERNAL_DIFF=...`).
  3. Emit zero-dependency `plugins/adlc-claude-code/hooks/generated-shell.mjs` from `scripts/ticket-readers/generate.mjs:53-59` and wire `Bash` write-gating + upward `enclosingAdlcRoot` into `plugins/adlc-claude-code/hooks/{hooks.json,adlc-hook.mjs}` so all 7 agent harnesses enforce one parser without `@adlc/*` runtime import failures.

### S7 `[CRITICAL]` — `tier.mjs` Omits 7 Harness Plugin Enforcement Cores + Required CI Gate Scripts, & `#141` Drops `review.commit_id` + Over-Lifts Globs
- **Locations:**
  - `packages/prosecute/lib/tier.mjs:26-106`
  - `AGENTS.md:201-208`
  - `scripts/rails-guard-ci.mjs:52-79` (`REPO_TRUST_ROOTS`)
  - `packages/rails-guard/lib/ci/rail-freeze.mjs:634-699` (`enforceTrustRoots`), `710-736` (`readPrContext`)
  - `packages/rails-guard/lib/trust-root-authorization.mjs:59-112` (`classifyTrustRootAuthorization`)
  - `docs/ci/required-gates.json:3` (`"pullRequestReview": "none"`)
- **Code Evidence:**
  - `AGENTS.md:201-208` states that plugin enforcement cores under `plugins/adlc-pi/lib`, `plugins/adlc-opencode/lib`, `plugins/adlc-{claude-code,codex,copilot,cursor,gemini}/hooks`, and `plugins/adlc-{cursor,gemini,opencode}/rails-checker.mjs` *"are trust-root tier: a same-model P5 is not sufficient, and a cross-model review must be recorded before merge."* Yet `tier.mjs` has **zero `plugins/` entries**, omits `packages/core/` (imported by every gate), `packages/tickets/` (trust-root reader/writer), `packages/hollow-test/` (required CI gate engine), and omits required CI scripts `scripts/mutation-gate.mjs`, `scripts/run-tests.mjs`, `scripts/scan-findings-ledger.mjs`, `scripts/guard-findings-ledger-append-only.mjs`, `packages/lesson-foundry/bin/ledger-guard.mjs`, `scripts/gate-liveness.mjs`, and `docs/ci/required-gates.json`.
  - In `#141`, `readPrContext` (`rail-freeze.mjs:724-728`) maps `{ user, state, submittedAt }` and **drops `review?.commit_id`**, so `classifyTrustRootAuthorization` (`trust-root-authorization.mjs:94-99`) accepts any prior `APPROVED` review regardless of commit SHA. Combined with `docs/ci/required-gates.json:3` (`"pullRequestReview": "none"`, no automatic stale-review dismissal on push), a follow-up commit pushed after CODEOWNER approval inherits `#141` authorization on unreviewed code.
  - Furthermore, `enforceTrustRoots` (`rail-freeze.mjs:694-698`) removes every `immutableTrustRoots` pattern satisfying `changedTrustRoots.some((path) => root === path || globMatch(root, path))` — lifting the entire `packages/rails-guard/lib/ci/**` glob whenever a single file under it was authorized.
- **Remediation:**
  1. Sequence `S11` (vendor-family normalization & multi-harness author provenance) and `S12` (`ignorePaths` leaf confinement) **first**, then expand `tier.mjs` (Wave 1) to cover all 7 harness plugin enforcement cores, `packages/core/`, `packages/tickets/`, `packages/hollow-test/`, `**/package.json`, `.adlc/lessons/**`, `.adlc/lenses/**`, and every required CI gate script + `docs/ci/required-gates.json`, followed by adding those paths to `REPO_TRUST_ROOTS` and `CODEOWNERS` (`.adlc/lessons/**` + `.adlc/lenses/**` in Wave 1 `C-T02`; plugin/script/`**/package.json` paths in Wave 4 `C-T03` once Waves 1–3 edits land).
  2. Preserve `commitId: review?.commit_id ?? review?.commitId` in `readPrContext` (`rail-freeze.mjs:724-728`) and require `review.commitId === headOid` inside `classifyTrustRootAuthorization` (`trust-root-authorization.mjs:94-99`) so post-review pushes fail closed until re-approved at `headOid`.
  3. In `enforceTrustRoots` (`rail-freeze.mjs:694-698`), authorize and exempt **only** the exact `nonExemptChangedRoots` file paths whose every `CODEOWNERS` owner approved `headOid`, rather than dropping whole directory globs from `unique`.

### S8 `[HIGH]` — Host-Process `require(tsPath)` Code Execution in `packages/core/lib/syntax.mjs`
- **Locations:**
  - `packages/core/lib/syntax.mjs:35-58` (`inspectTypeScript`), `73-75` (`resolveTypeScript`), `139-150` (`syntaxCheckProblem`)
- **Code Evidence:**
  - Although PR #1402 moved `transpileModule` into a child process (`syntax-check-typescript.mjs`), `resolveTypeScript(filePath)` (`syntax.mjs:73-75`) and `syntaxCheckProblem(filePath)` (`syntax.mjs:139-150`) still call `inspectTypeScript(filePath)` (`syntax.mjs:35-58`), which walks `typeScriptCandidates(filePath)` from `dirname(resolve(filePath))` and runs `const require = createRequire(...); const path = require.resolve('typescript'); const ts = require(path)` (`lines 41-43`) **inside the parent gate/CLI process**.
- **Architectural Impact & Boundary Gap:**
  - Resolving `typescript` from the candidate directory inside the parent gate process executes candidate `node_modules/typescript` code in the parent process environment before worker isolation begins.
- **Remediation:**
  - Move `require.resolve('typescript')` + API probing (`createSourceFile`, `createProgram`) into `packages/core/lib/syntax-check-typescript.mjs` (`--probe`, spawned with `sanitizeCandidateEnv(process.env)` so `ADLC_MANIFEST_KEY` and API keys are stripped), preserving the exact `resolveTypeScript(filePath)` and `syntaxCheckProblem(filePath)` return shapes tested by frozen `packages/core/test/syntax.test.mjs`.

### S9 `[HIGH]` — Duplicate `forestChainsIntact` in `@adlc/tickets` Misses Keyed-Forest Enforcement & Emits v1 Signatures on `seq >= 2`
- **Locations:**
  - `packages/tickets/lib/manifest-segments.mjs:52-85` (`forestChainsIntact`) & `packages/tickets/lib/manifest-primitives.mjs:1-120`
  - `packages/gate-manifest/lib/forest.mjs:12-33,64-118`
  - `packages/tickets/lib/evidence.mjs:179-182` (`appendSegmentEntry`)
  - `packages/ticket-sync/lib/reassign.mjs:136-137`
- **Code Evidence:**
  - `packages/tickets/lib/manifest-segments.mjs:52-85` maintains a duplicate of `@adlc/gate-manifest`'s `verifyForest` that: (1) never reads `.adlc/manifest.d/.store.json` (`auth: "keyed"` hardened in PR #1402), (2) resets `let seenSignedEntry = false` per segment loop (`line 65`), allowing unsigned rogue segments to pass `verifyTicketEvidence`, and (3) skips `anchor` cross-file existence checks.
  - Meanwhile, `packages/tickets/lib/evidence.mjs:180` and `packages/ticket-sync/lib/reassign.mjs:136` sign only `seq === 1` with `signV2` (binding `segmentId` + `anchor`) and sign all `seq >= 2` entries with legacy `sign()` (v1, omitting `segmentId`).
- **Remediation:**
  1. Consolidate the canonical chain, fork-anchor (`resolveAnchor`, `detectAnchorCycle`), and `.store.json` `auth: "keyed"` forest verification downward into `packages/tickets/lib/manifest-primitives.mjs` (which `@adlc/gate-manifest/lib/forest.mjs:12-23` already imports without introducing any `@adlc/tickets <-> @adlc/gate-manifest` dependency cycle), and have both `packages/tickets/lib/manifest-segments.mjs` and `packages/gate-manifest/lib/{forest,verify}.mjs` delegate to it.
  2. Sign **all** newly written segment entries (`seq >= 1`) with `signV2` (`sigVersion: 2`) in `packages/tickets/lib/evidence.mjs` and `packages/ticket-sync/lib/reassign.mjs`, keeping forest verification backward-compatible with historical `sigVersion !== 2` entries committed in `.adlc/manifest.d/`.

### S10 `[HIGH]` — Local Segment Truncation + `--carry-forward` Launders Revoked Verdicts & Resets `CARRY_FORWARD_MAX_DEPTH`
- **Locations:**
  - `packages/prosecute/lib/attestation-store.mjs:86-95` (`assertNoTruncation`)
  - `packages/prosecute/lib/cross-model.mjs:159-300,392-405,505-523` (`carryForwardCrossModelReview`, `crossModelSatisfied`, `hasCrossModelApproveForRevision`)
  - `packages/prosecute/bin/adlc-prosecute.mjs:833-852` (`record-cross-model --carry-forward`)
- **Code Evidence:**
  - `assertNoTruncation` (`attestation-store.mjs:86-95`) scans `observedEntries` (mirrored onto orphan branch `refs/heads/adlc-attestations` by `.github/workflows/cross-model-gate.yml:107-166`) **only** for `entry.data?.revision === revision` (`HEAD`).
  - Neither `carryForwardCrossModelReview` (`record-cross-model --carry-forward`, which lacks `--attestation-store`) nor `crossModelSatisfied` / `hasCrossModelApproveForRevision` checks `observedEntries` for `carriedFrom` ancestor revisions or matching `changeSetDigest`, and `carryDepth` (`cross-model.mjs:277`) is trusted solely from local segment lines rather than mirrored ancestor state (`CARRY_FORWARD_MAX_DEPTH = 3`).
- **Remediation:**
  1. Update `assertNoTruncation` and `crossModelSatisfied` so `observedEntries` is consulted across the entire `carriedFrom` ancestor chain and matching `changeSetDigest` set (preserving `mirror-attestations` **before** `tier-check` in `cross-model-gate.yml:140-166` so valid HMAC-signed `needs-attention` revocations are always recorded onto `adlc-attestations`): if any mirrored entry in the ancestor chain has a superseding `needs-attention` or higher segment `seq` than HEAD's local segment, fail closed (`ATTESTATION_TRUNCATED` / `SUPERSEDED`).
  2. Add `--attestation-store` support to `record-cross-model --carry-forward` so callers verify against `adlc-attestations` before minting a carry-forward record.

### S11 `[HIGH]` — Cross-Model Self-Review via Static `ADLC_AUTHOR_PROVIDER='anthropic'`, Missing Vendor-Family Normalization & Hardcoded `autopilot` Provider
- **Locations:**
  - `.github/workflows/cross-model-gate.yml:174`
  - `packages/prosecute/lib/cross-model.mjs:62-66` (`normalizeProvider`), `342-352` (`crossModelSatisfied`)
  - `packages/autopilot/lib/review.mjs:200-201`
- **Code Evidence:**
  - `cross-model-gate.yml:174` hardcodes `ADLC_AUTHOR_PROVIDER: ${{ vars.ADLC_AUTHOR_PROVIDER || 'anthropic' }}` and `crossModelSatisfied` (`cross-model.mjs:344`) requires `entryAuthor === expectedAuthor` (`'anthropic'`). Consequently, non-Anthropic author sessions (`openai` or `google`) either cannot record their true `authorProvider` without CI rejection (`entryAuthor !== 'anthropic'`) or lack distinct-family verification against the actual builder vendor.
  - `normalizeProvider` (`cross-model.mjs:62-66`) only trims/lowercases, failing to canonicalize vendor aliases (`claude` = `anthropic`, `codex`/`gpt`/`o1`/`o3`/`o4` = `openai`, `gemini`/`agy` = `google`) — unlike `packages/review-calibration/lib/judge.mjs:196-200`.
  - `packages/autopilot/lib/review.mjs:200-201` hardcodes `--author-provider anthropic --provider codex` regardless of which fleet builder adapter wrote the branch.
- **Remediation:**
  1. Canonicalize provider strings to vendor families (`anthropic`, `openai`, `google`, etc.) in `normalizeProvider` (`cross-model.mjs`) so same-family aliases (`claude` vs `anthropic`) are rejected as same-vendor.
  2. In `crossModelSatisfied` (`cross-model.mjs:342-352`), enforce `canonicalFamily(entry.data.provider) !== canonicalFamily(entry.data.authorProvider)`, cross-checked against any author provider recorded on the ticket/P4 build evidence when present, and treat `ADLC_AUTHOR_PROVIDER` in `cross-model-gate.yml` as an optional pin (`vars.ADLC_AUTHOR_PROVIDER` when explicitly configured, rather than defaulting to `'anthropic'` and rejecting honest `openai`/`google` authors).
  3. Derive `--author-provider` and `--provider` dynamically from the active builder and reviewer adapters in `packages/autopilot/lib/review.mjs:200-201`.

### S12 `[HIGH]` — `computeTreeIdentity` Directory Prefix Masking via Unvalidated `--input` `provenance.transcript`
- **Locations:**
  - `packages/prosecute/lib/run.mjs:52-60`
  - `packages/prosecute/bin/adlc-prosecute.mjs:793-826` (`record-cross-model --input`)
  - `packages/core/lib/revision.mjs:149-152` (`isIgnoredPath`)
- **Code Evidence:**
  - `record-cross-model --input <packet>` (`adlc-prosecute.mjs:795-799`) pushes `relWithinCwd(cwd, parsedInput.provenance.transcript)` into `ignorePaths`, and `isIgnoredPath` (`packages/core/lib/revision.mjs:151`) matches `relPath.startsWith(ig + '/')`.
- **Architectural Impact & Boundary Gap:**
  - When `provenance.transcript` resolves to a repository directory name rather than a verified regular file inside an evidence directory, prefix matching in `isIgnoredPath` excludes untracked files under that subtree from `computeTreeIdentity` (`#619`).
- **Remediation:**
  1. Restrict `ignorePaths` in `packages/core/lib/revision.mjs:149-152` to exact leaf paths (`relPath === ig`) unless the caller explicitly passes a trailing `'/'` directory token from an internal allowlist.
  2. Validate in `adlc-prosecute.mjs` and `prosecute/lib/run.mjs` that `input` and `provenance.transcript` resolve within `.adlc/tmp/`, `.adlc/evidence/`, or `.omo/evidence/` (or outside `cwd`) and are regular files (`lstatSync().isFile()`).

### S13 `[HIGH]` — Manifest Pre-Store Seeding Gap, Staged-Index Blindness in Local `rails-guard` & `ledger-guard`, Stale `enable.mjs` Warning, and Keyed-Forest vs `signed` Runner Model Split
- **Locations:**
  - `packages/rails-guard/lib/ci/rail-freeze.mjs:88-115`
  - `packages/rails-guard/lib/ci/bootstrap.mjs:79-83,132-221`
  - `packages/gate-manifest/lib/enable.mjs:38-57`
  - `packages/rails-guard/bin/rails-guard.mjs:128,206-239`
  - `packages/lesson-foundry/lib/ledger-guard.mjs:19-30,106-137`
  - `.adlc/config.json:3` & `.adlc/manifest.d/.store.json`
- **Code Evidence:**
  1. **Pre-store `verifyManifest` skip (`rail-freeze.mjs:98-114` & `bootstrap.mjs:79-83`):** When `!baseHasConfig` and base throws `STORE_NOT_FOUND`, `rail-freeze.mjs:104-113` checks only whether `HEAD` is non-empty (`bootstrap.root.text.trim()` / `bootstrap.segments.size > 0`) and returns `status: 0` **before** reaching `verifyManifest()` at `line 156` — so deleting pre-existing base `.adlc/manifest.jsonl` or `.adlc/manifest.d/*.jsonl` files in a repo without `.adlc/config.json` yields an empty `HEAD` snapshot and passes `status: 0`; meanwhile `bootstrap.mjs:79-83` checks only `.adlc/manifest.jsonl` and ignores `.adlc/manifest.d/`.
  2. **Stale `CI_COVERAGE_WARNING` in `enable.mjs` (`packages/gate-manifest/lib/enable.mjs:38-57`):** Still warns operators that `rails-guard does not yet validate .adlc/manifest.d/ segment files`, contradicting PR #1402's `packages/rails-guard/lib/ci/manifest.mjs` segmented-forest enforcement.
  3. **Local `adlc rails-guard` staged-index split (`packages/rails-guard/bin/rails-guard.mjs:128,206-239`):** Although `coreChangedFiles(base)` (`line 129`) unions worktree + `--cached`, `gitDiff(base)` (`line 128`, used for suppression-comment scanning) omits `--cached`, and `resolveContents` (`lines 206-239`, used for the ADR-0012 version-only manifest exemption) reads **only** working-tree `readFileSync(file)` (`line 238`). Staging a `"postinstall"` in `package.json` while leaving only a `"version"` bump in the working tree causes local `adlc rails-guard` to exempt `package.json` (`exit 0`) right before `git commit` commits the staged `"postinstall"`.
  4. **`ledger-guard` symlink & staged-index bypass (`packages/lesson-foundry/lib/ledger-guard.mjs:19-30,106-137`):** Reads working-tree `readFileSync` without `lstatSync` (follows symlinks) or `:0:<path>` staged-blob inspection, and strips trailing `\n` before prefix comparison (`lines 125-137`), permitting staged truncation or newline corruption of `.adlc/findings.jsonl`.
  5. **`.adlc/config.json` (`"unsigned-fallback"`) vs `.adlc/manifest.d/.store.json` (`"auth": "keyed"`) & `verifySignedRunner` constraint (`bootstrap.mjs:132-221`):** On GitHub-hosted `ubuntu-latest` runners, `verifySignedRunner` (`bootstrap.mjs:160-221`) rejects `"securityMode": "signed"` unless `RUNNER_ENVIRONMENT === 'self-hosted'`, `ADLC_SIGNED_RUNNER_POOL === '1'`, `runnerBinarySha256` is pinned, and `adlc-runner` implements `record --help` / `upgrade --help` (`packages/runner/bin/adlc.mjs` currently implements only `run`). Because `.adlc/config.json:3` must remain `"unsigned-fallback"` on GitHub-hosted runners, `rail-freeze.mjs` must never allow a PR to downgrade `.adlc/manifest.d/.store.json` from `"auth": "keyed"` to `"keyless"` while `.adlc/config.json` is `"unsigned-fallback"`.
- **Remediation:**
  1. Run `verifyManifest` even on `STORE_NOT_FOUND` in `rail-freeze.mjs:96-115`, enforce `.adlc/manifest.d/.store.json` `"auth": "keyed"` immutability regardless of `securityMode`, and check `.adlc/manifest.d/` in `bootstrap.mjs:79-83`; update `CI_COVERAGE_WARNING` / `SEGMENTATION_UNDETERMINED_WARNING` in `enable.mjs:38-57`.
  2. Inspect both working tree and staged index (`--cached` + `:0:<path>`) in `packages/rails-guard/bin/rails-guard.mjs` and `packages/lesson-foundry/lib/ledger-guard.mjs`, enforce `lstatSync().isFile()`, and require exact byte-prefix append in `ledger-guard.mjs`.
  3. Keep GitHub-hosted CI on `"auth": "keyed"` + isolated `cross-model-gate.yml` HMAC verification, and gate any future `.adlc/config.json` `"securityMode": "signed"` cutover (`PRE-1`) strictly on implementing `adlc-runner` `record`/`upgrade`, provisioning the `adlc-signed` self-hosted runner pool (`bootstrap.mjs:160-221`), and verifying historical manifest signature compatibility.

### S14 `[HIGH]` — Plugin & Adapter Containment Gaps (`trusted-binary`, `fleet` Home Mounts, Subdir/Symlink Hook Escapes & MCP Env Scrubbing)
- **Locations:**
  - `packages/core/lib/trusted-binary.mjs:33-43` & `packages/lesson-foundry/lib/emit.mjs:128-130`
  - `packages/fleet/lib/adapters/agy.mjs:11-15`, `jetski.mjs:11-15`, `gemini.mjs:49-76`
  - `plugins/adlc-codex/hooks/adlc-rails-guard.mjs:218` & `plugins/adlc-copilot/hooks/adlc-rails-guard.mjs:218`
  - `plugins/adlc-pi/lib/rails-checker.mjs:88-108,177-184,229-245`
  - `plugins/adlc-gemini/hooks.json:9,21,33,45`, `plugins/adlc-gemini/hooks/adlc-rails-guard.cjs:7-19,65-72`
  - `.mcp.json` & plugin MCP configs (`packages/cli/lib/mcp-server.mjs`)
- **Code Evidence & Remediations:**
  1. **`ownershipRejection` (`packages/core/lib/trusted-binary.mjs:33-43`):** `if (file.uid === selfUid) return null;` returns at `line 34` **before** checking `(file.mode & 0o022) !== 0` or `dir`/`ancestors` writability (`0o022`), allowing group/world-writable binaries or directories owned by `selfUid` (and duplicated in `lesson-foundry/lib/emit.mjs:128-130`). Fix: check `(file.mode & 0o022) === 0` and directory mode/uid for both `selfUid` and `uid 0`, and share `resolveTrustedBinary`.
  2. **Fleet `agy`/`jetski` writable config roots (`packages/fleet/lib/adapters/agy.mjs:11-15`, `jetski.mjs:11-15`):** Mounts the entire `~/.antigravity` / `~/.jetski` root writable inside `bwrap` (unlike `claude-code.mjs`/`codex.mjs`/`gemini.mjs`, which mount config read-only and open only leaf state subpaths writable), allowing sandboxed workers to plant persistent hooks/settings on the host; `gemini.mjs:49-76` `detectBinary` accepts bare exit `0` without checking `--version` output identity. Fix: split `authReadOnlySubpaths` from narrow leaf `authWritableSubpaths` in `agy.mjs`/`jetski.mjs` and validate Gemini CLI version banner in `gemini.mjs`.
  3. **Hook subdir & symlink escapes (`adlc-codex`, `adlc-copilot`, `adlc-pi`, `adlc-gemini`):**
     - `adlc-codex` and `adlc-copilot` `adlc-rails-guard.mjs:218` look up `join(cwd, '.adlc', 'tickets')` without walking upward via `enclosingAdlcRoot(cwd)`, failing open when `cwd` is a subdirectory, and `normalizePath` (`line 47`) uses lexical `posix.normalize` without `realpathSync` ancestor resolution.
     - `plugins/adlc-pi/lib/rails-checker.mjs:88-97` checks `globMatch(rail, candidate)` without checking ancestor-directory deletions (`rm -rf test` misses exact rail `test/foo.test.mjs`), `pathInScope` (`lines 100-108`) uses lexical `canonicalizePath(filePath, root)` without `resolveRailPath` symlink resolution, and `checkCustomTool` (`lines 229-245`) allows unknown tools with no extractable path keys.
     - `plugins/adlc-gemini/hooks.json:9,21,33,45` uses unquoted `$HOME/.gemini/config/plugins/adlc-gemini/hooks/adlc-rails-guard.cjs` (breaks when `$HOME` contains spaces); `plugins/adlc-gemini/hooks/adlc-rails-guard.cjs:7-19` fails **open** (`{ decision: 'allow', allow_tool: true }`) on uncaught errors whenever `ADLC_P4_ENFORCEMENT !== '1'` (the default), calls `process.exit(0)` immediately after async `process.stdout.write(...)` (`line 8`), and writes crash markers into shared `/dev/shm/.adlc` (`lines 67-69`) without `O_NOFOLLOW` or per-user mode-`0700` isolation.
     - Fix: walk `enclosingAdlcRoot(cwd)`, resolve real ancestor paths (`resolveRailPath`), check ancestor-directory deletions (`cand === rail || rail.startsWith(cand + '/')`), quote hook paths in `plugins/adlc-gemini/hooks.json`, fail closed on `PreToolUse` errors regardless of `ADLC_P4_ENFORCEMENT`, use `fs.writeSync(1, ...)` before `process.exit(0)`, and move crash state into a mode-`0700` per-user runtime directory.
  4. **MCP Server `ADLC_MANIFEST_KEY` Scrubbing (`packages/cli/lib/mcp-server.mjs`):** Scrub `ADLC_MANIFEST_KEY` inside `packages/cli/lib/mcp-server.mjs` at startup (deleting `process.env.ADLC_MANIFEST_KEY` and scrubbing child spawn environments, matching `adlc-cursor/bin/adlc-mcp-wrapper.mjs`).

### S15 `[MEDIUM]` — Secondary Gate Hardening (`risk-tier`, `runner` P4/P6, `TicketService.planReconciliation`, `quartermaster`, `consensus-fix`, `decision-layer`, `mcp-server`, `prosecute`, `check-reviewer-directed-comments`)
- **Locations & Defects:**
  1. **`packages/core/lib/risk-tier.mjs:101-152` (`filesOverlapOrUnscoped`, `decideAdversarialReviewNotice`):** `decideAdversarialReviewNotice` (`lines 144-150`) treats **any** `e.gate === 'adversarial-review'` entry as satisfying `hasRecord` without checking `e.data?.verdict === 'approve'` (so a recorded `'needs-attention'` verdict suppresses the notice), and `filesOverlapOrUnscoped` (`lines 101-108`) combined with `!e.ticket` (`line 148`) lets an unscoped review entry with neither `ticket` nor `files` satisfy `hasRecord` globally for unrelated gated files.
  2. **`packages/runner/lib/assertions.mjs:29-38,388-406,435,529,609-616` & `acceptance.mjs:28-85`:** P4 trusts self-declared `--files` without intersecting real `changedFiles(baseRef)`; P6 accepts symlinked `--packet` or 1-byte `{}` JSON lacking `summary`/`residualRisks`/`humanSignoff`; P1/P2/P5 manifest checks accept bare gate-type presence even when `verdict` is failing (`wishCount > 0`, `needs-attention`, or `blocked`); `verifyAcceptance` trusts `summary.json` status strings without checking actual git diff / rail invariants.
  3. **`packages/tickets/lib/service.mjs:275-309` (`planReconciliation`):** Skips `#assertNoManifestRails` and `#assertRailsExist` on updated tickets and omits `ticket-mutation` manifest evidence on `plan.remove` deletions.
  4. **`packages/quartermaster/lib/registry-path.mjs:85-102` & `load.mjs:68`:** `realpathSync` validation followed by path-reopen `readFileSync` instead of `readBoundedRegularFile` (`packages/core/lib/primitives.mjs:270-293` with `O_NOFOLLOW` + size cap).
  5. **`packages/consensus-fix/bin/consensus-fix.mjs:72-73,213,256-265`:** Parses `--files` and applies winner patches (`applyWinner`) without upfront `resolveTarget(repoRoot, file)` repo-containment validation or `@adlc/core` active-ticket/trust-root rail checks (`loadTickets`, `activeTickets`, `globMatch`, `resolveRailPath`, `TICKET_TRUST_ROOT_RAILS`), while `snapshot.mjs` intentionally preserves in-repo symlinks (`snapshot.test.mjs:116-145`).
  6. **`packages/decision-layer/lib/adapters/jev.mjs:35-40`, `pack.mjs:211-235`, `record.mjs:16,64-66`:** `jev.mjs:35-40` enforces `https:` yet lacks a host allowlist before sending `TYPESAFE_API_KEY` to `TYPESAFE_API_URL`; `pack.mjs:211-235` lacks `realpathSync` ancestor symlink/containment checks entirely; `record.mjs:64-66` (`appendRecord`) appends to `runs.jsonl` without a ledger lock and leaks raw filesystem paths in errors.
  7. **`packages/cli/lib/mcp-server.mjs:28-45` & `plugins/adlc-opencode/rails-checker.mjs:810-822`:** `FORBIDDEN_FLAGS` (`mcp-server.mjs:28-45`) and OpenCode `MUTATION_FLAGS` (`rails-checker.mjs:810-822`, which blocks `'--apply'` and `/^--[a-z][a-z-]*cmd$/`) miss full `--*command` flag spellings (`--lint-command`, `--typecheck-command`, `--test-command`).
  8. **Prompt, Prosecutor & Comment-Lexer Hardening:** Unfenced untrusted ticket/diff interpolations in `packages/parallax/lib/prompts.mjs:61-62,174,206` (wrap with `@adlc/core`'s UUID-nonced `fence()` in `packages/core/lib/text.mjs:84-118`); silent 8KB spec truncation in `packages/spec-lint/lib/llm.mjs:32`; unvalidated `--record-verdict` exit `0` on `blocked`/`fail` in `coldstart`/`premortem`/`parallax`; lens-subset gaming (`--lenses diff` recording `approve` without `correctness`/`security`), symlinked `transcript` copy (`run.mjs:405`), and caller-supplied `--revision` echo (`run.mjs:599`) in `packages/prosecute/lib/run.mjs`; single-line-only template-literal backtick scanning (`isInsideStringLiteral` at `scripts/check-reviewer-directed-comments.mjs:290-321`, allowing `/*` inside multi-line JS template literals to desync `classifyLines` at `lines 360-375`) and single-blank-line comment-block splitting in code files (`!treatEveryLineAsComment` — keeping `.md` paragraph boundaries at `lines 351-358` intact to prevent whole-document prose false positives).

---

## Part II: Reliability, Correctness & Cross-Harness Parity (`R1–R7`)

### R1 `[CRITICAL]` — `autopilot` `pinToolchain` Rejects `node_modules` Symlink Targets & `readSet` / `fleet` Bounded Read-Set Omit CLI Package Trees
- **Locations:**
  - `packages/autopilot/lib/tools.mjs:78-91` (`pinToolchain`)
  - `packages/autopilot/lib/fleet-args.mjs:16,43-53` (`SYSTEM_ROOTS`, `readSet`)
  - `packages/fleet/lib/bounded-model-plane.mjs:33` (`SYSTEM_ROOTS`) & `packages/fleet/lib/extensions.mjs:106-111,126` (`NODE_TOOL_TREE_RE`)
- **Code Evidence:**
  - `pinToolchain` (`packages/autopilot/lib/tools.mjs:79-83`) resolves `real = realpath(found)`, splits `parts = real.split(sep)`, and throws `new ToolError('untrusted-tool:${name}', '${real} resolves under a rejected directory')` whenever `parts.includes('node_modules')` (`line 81`). On standard Node installations (`fnm`, `nvm`, `volta`, Homebrew, Linux `/usr/local`), `<prefix>/bin/npm`, `<prefix>/bin/adlc`, `<prefix>/bin/codex`, and `<prefix>/bin/adversarial-review` are symlinks into `<prefix>/lib/node_modules/<pkg>/...` — meaning `parts.includes('node_modules')` is **unconditionally true** and `pinToolchain` aborts before `autopilot` can start.
  - Furthermore, `readSet` (`packages/autopilot/lib/fleet-args.mjs:43-53`) and `NODE_TOOL_TREE_RE` (`packages/fleet/lib/extensions.mjs:126`) permit only single entrypoint `files` (`pinnedRealpaths`, keeping `bin/` directories unmounted so `gh` is never exposed per `fleetArgs.bindToolDirs`) plus `<prefix>/lib/node_modules/{npm,corepack}`, omitting the resolved global package trees of `@adlc`, `@openai/codex`, and `adversarial-review` (causing relative ESM imports inside those global CLI packages to fail with `ERR_MODULE_NOT_FOUND` inside `bwrap`), while `SYSTEM_ROOTS` (`fleet-args.mjs:16` and `bounded-model-plane.mjs:33`) omits `/bin` and macOS roots (`/System`, `/Library`, `/private/etc`).
- **Remediation:**
  1. In `packages/autopilot/lib/tools.mjs:80-85`, reject `node_modules` on the **unresolved `PATH` entry** (`candidateRejection` in `trusted-binary.mjs:108`) or when `real` resolves inside `repoRoot` / `.worktrees` / untrusted project trees, while allowing global prefix `<prefix>/lib/node_modules/...` targets that pass hardened `ownershipRejection`.
  2. Update `packages/autopilot/lib/fleet-args.mjs:16,43-53`, `packages/fleet/lib/bounded-model-plane.mjs:33`, and `packages/fleet/lib/extensions.mjs:106-111,126` in lockstep to allow each pinned CLI's resolved package tree under `<prefix>/lib/node_modules/<scope-or-pkg>` (never binding `<prefix>/bin` directories, preserving `fleetArgs.bindToolDirs` and `checkReadSetInvariant`) plus `/bin` and macOS system roots (`/System`, `/Library`, `/private/etc`).

### R2 `[CRITICAL]` — `fleet` `READ_POLICY.BOUNDED` Omits `readOnlyPaths` / `/dev` / `/proc` / `/tmp`, & `autopilot` `gates.mjs` Crashes on macOS Seatbelt
- **Locations:**
  - `packages/fleet/lib/live-deps.mjs:330-355` (`sandboxFor`)
  - `packages/fleet/bin/fleet.mjs:544` (`dispatchCanary` passing `canaryReadOnlyPaths`)
  - `packages/fleet/lib/sandbox.mjs:230-243` & `packages/fleet/lib/safe-sandbox.mjs:59-84`
  - `packages/autopilot/lib/gates.mjs:114-144` (`composeGateArgv`, `spawnInGateSandbox`)
- **Code Evidence:**
  - `packages/fleet/bin/fleet.mjs:544` passes `canaryReadOnlyPaths` (`--canary-ro-path` from `autopilot/lib/fleet-args.mjs:46`), yet `sandboxFor` (`packages/fleet/lib/live-deps.mjs:335-343`) constructs `new SafeSandbox({ backend, worktreePath, readPolicy: READ_POLICY.BOUNDED, extraWritablePaths, envAllowlist })` — **dropping `readOnlyPaths`**. And `SafeSandbox` under `READ_POLICY.BOUNDED` mounts only `worktreePath` + `extraWritablePaths` with zero `/usr`, `/lib`, `/bin`, `/dev`, `/proc`, or `/tmp`, causing `fleet --read-policy bounded` to fail immediately (`ENOENT` spawning `sh`/`node`).
  - Meanwhile, `spawnInGateSandbox` (`packages/autopilot/lib/gates.mjs:136-144`) passes `sandbox.wrap(inner)` into `composeGateArgv` (`lines 114-124`), which searches `wrapped.indexOf('--chdir')` (`bwrap`-only flag) and throws `GatesError('sandbox-unavailable', 'unexpected sandbox argv shape')` on macOS `sandbox-exec` (`Seatbelt`).
- **Remediation:**
  1. Forward `readOnlyPaths` through `sandboxFor` (`packages/fleet/lib/live-deps.mjs:335-343`) into `SafeSandbox` (`packages/fleet/lib/safe-sandbox.mjs`, leaving frozen `packages/fleet/lib/sandbox.mjs` untouched until `PRE-0` completes `T-01M0Z3FN...` / `T-01M0Z3G8...` / `T-01M7FQ...`), and include `/dev`, `/proc`, and isolated `--tmpfs /tmp` in `SafeSandbox`'s `READ_POLICY.BOUNDED` `bwrap` profile.
  2. Add first-class `readOnlyPaths` / `writablePaths` / `bindDeps` options to `buildSandboxPlan` (`packages/core/lib/sandbox-runner.mjs`, re-exported from root `@adlc/core`) for **both** Linux `bwrap` and macOS `Seatbelt`, and update `composeGateArgv` / `spawnInGateSandbox` (`packages/autopilot/lib/gates.mjs:114-144`) to support both backends cleanly.

### R3 `[HIGH]` — `scopesOverlap` Misses Leading-Wildcard Globs (`**/*.mjs`) & `merge-forecast` Drops Shared Matched Files Across Distinct Globs
- **Locations:**
  - `packages/core/lib/tickets.mjs:142-156` (`scopesOverlap`)
  - `packages/merge-forecast/lib/signals.mjs:22-24,153-170,275-290` (`signalScopeOverlap`, `signalCoChange`, `signalGraphCoupling`)
- **Code Evidence:**
  - In `scopesOverlap` (`packages/core/lib/tickets.mjs:150-152`), `'**/*.mjs'.split('*')[0]` returns `""`, and `if (aBase && bBase && (aBase.startsWith(bBase) || bBase.startsWith(aBase)))` evaluates `""` as falsy — returning **`false`** for `scopesOverlap({ scope: ['**/*.mjs'] }, { scope: ['packages/core/lib/git.mjs'] })`. Even for non-empty prefixes (`packages/cli` vs `packages/cli-utils/index.mjs`), `aBase.startsWith(bBase)` lacks a `/` segment boundary check.
  - Consequently, when two tickets declare distinct globs matching the **exact same concrete repository file** (`index.files(a.scope)` intersecting `index.files(b.scope)`, e.g. `**/*.mjs` vs `packages/core/lib/git.mjs`), `signalScopeOverlap` (`signals.mjs:22-24`) returns `0` while `signalCoChange` (`line 162`) and `signalGraphCoupling` (`line 282`) execute `if (fa === fb) continue;` — yielding zero overlap signal on the shared file and allowing `PARALLEL` classification.
- **Remediation:**
  1. Fix `scopesOverlap` in `packages/core/lib/tickets.mjs:142-156`: test `globMatch(ga, gb)` / `globMatch(gb, ga)` directly, enforce segment-boundary prefix checks (`aSeg === bSeg || aSeg.startsWith(bSeg + '/')`), and handle leading `**/` globs via suffix/segment intersection.
  2. Check non-empty `index.files(a.scope)` ∩ `index.files(b.scope)` directly in `merge-forecast/lib/signals.mjs` so any pair of tickets matching a shared concrete file triggers `hardVeto` (never `PARALLEL`).

### R4 `[HIGH]` — Systemic Lock Theft, Race Conditions & Missing Stale-PID Recovery Across 7 Packages
- **Locations:**
  - `packages/core/lib/ledger.mjs:30-36` (`isStaleLockOwner` in `withLedgerLock`) & `packages/core/lib/primitives.mjs:74-155` (`acquireDirLock`)
  - `packages/fleet/lib/lock.mjs:52-53,112-124` (`acquireLock`, `releaseLock`)
  - `packages/context-handoff/lib/lock.mjs:19-28,85-94` & `deny-marker.mjs:417-448`
  - `packages/tickets/lib/lock.mjs:35-65`, `packages/tickets/lib/evidence.mjs:53-77`, `packages/ticket-prune/lib/store.mjs:19-40`
  - `packages/backlog-groom/lib/io.mjs:308-309,428`
  - `packages/review-calibration/lib/inflight.mjs:88-90`
  - `packages/autopilot/lib/lock.mjs:123`
- **Code Evidence:**
  1. **Unconditional live-lock theft in `isStaleLockOwner` (`packages/core/lib/ledger.mjs:30-36`):** When `current.hostname === hostname()` and `isPidAlive(current.pid)` is **`true`**, line 32 is `false` and execution falls through to line 35 (`now() - Date.parse(current.startedAt) > staleMs`), stealing `.adlc/findings.jsonl.lock` after `60_000ms` **even while the holder process is still alive** during multi-minute LLM runs.
  2. **Two-step `mkdirSync` -> `writeFileSync(owner.json)` race & unverified `releaseLock`:** `packages/fleet/lib/lock.mjs:52-53`, `context-handoff/lib/lock.mjs:85-94`, and `primitives.mjs:76-85` (`acquireDirLock`) create `mkdirSync(lockDir)` before writing `owner.json`; in `fleet/lib/lock.mjs:112`, a concurrent acquirer observing empty `owner.json` parses `null` and `rmSync`s the live lock, and `releaseLock` (`line 67`) `rmSync`s without verifying holder `token`.
  3. **Permanent wedge after crash (`SIGKILL`):** `packages/tickets/lib/lock.mjs`, `packages/tickets/lib/evidence.mjs`, and `packages/ticket-prune/lib/store.mjs` spin for `5_000ms` with **zero stale-PID / `procStartTimeOf` recovery**, wedging `.adlc/tickets/.lock` after a crash.
  4. **Non-atomic lockfile & uncalled heartbeat:** `backlog-groom/lib/io.mjs:308-309` writes its lock without `wx` or `procStartTimeOf`; `review-calibration/lib/inflight.mjs:88-90` mutates its journal with no lock; `autopilot/lib/lock.mjs:123` defines `heartbeat()` and never calls it across multi-hour runs (`run.mjs`).
- **Remediation:**
  - Harden `acquireDirLock` (and add `withDirLock` + `heartbeat()`) in `packages/core/lib/primitives.mjs:74-155` using atomic staging rename (`mkdirSync` temp staging dir + pre-written `owner.json` `{ pid, pidStartTime, hostname, token, createdAt }` -> `renameSync(stagingDir, lockDir)`), `pidAlive` + `procStartTimeOf` liveness checks that **never** steal a live same-host PID on age alone (fixing `ledger.mjs:30-36` too), bounded retry/wait options, and periodic `heartbeat()` wired into `autopilot/lib/run.mjs`.

### R5 `[HIGH]` — Fleet Worker Self-Commit / Strike-2 Amend Failures & `autopilot` Non-`test (` Skipped-Gate `pass` + Partial Matrix `seen`
- **Locations:**
  - `packages/fleet/lib/worktrees.mjs:172-195` (`commitWorker`, unused `resetWorktree`)
  - `packages/fleet/lib/git-mirror.mjs:272` (`mirrorFetchBack` `is-ancestor`)
  - `packages/autopilot/lib/ci.mjs:37-80` (`normalizeRow`, `blockingPrefixOf`, `normalizeChecks`), `134-182` (`watchCi`)
- **Code Evidence:**
  1. **Self-committing workers fail `commitWorker` (`worktrees.mjs:172-186`):** Capable agents (`claude`, `codex`, `agy`) commit their work inside the worktree. Then `commitWorker` runs `git status --porcelain` -> empty (`""`) -> returns `{ committed: false }` even though `HEAD !== cutTip`, or when Strike 2 runs `git commit --amend` / `git reset`, `mirrorFetchBack` (`git-mirror.mjs:272`) checks `merge-base --is-ancestor prevTip newTip` against Strike 1's aborted tip instead of `cutTip`, failing with terminal `mirror-fetch-failed`. Meanwhile `resetWorktree` (`worktrees.mjs:193`) is never called between strikes.
  2. **`autopilot` treats `skipped` non-`test (` blocking gates as `'pass'` and marks matrix prefixes `seen` on 1 leg (`autopilot/lib/ci.mjs:69-71`):** In `normalizeChecks` (`ci.mjs:71`), `if (norm === 'skipped') effective = prefix.startsWith('test (') && !active('ci.skippedIsPass') ? 'red' : 'pass';` — so if any other blocking gate (`rail-freeze`, `mutation-gate`, `cross-model-gate`, `ticket-store-platform (`) reports `skipping`, `normalizeChecks` scores it `'pass'`; and `seen.add(prefix)` (`line 69`) marks `ticket-store-platform (` present as soon as a single OS leg reports, missing unscheduled sibling matrix legs.
- **Remediation:**
  1. In `worktrees.mjs:172-186`, treat `HEAD !== cutTip` (verified via `git rev-list --count cutTip..HEAD > 0` with clean porcelain) as `{ committed: true }`, call `resetWorktree(worktree, cutTip)` before clean-slate Strike retries when configured, and anchor `mirrorFetchBack`'s ancestry invariant (`git-mirror.mjs:272`) to `cutTip`.
  2. In `packages/autopilot/lib/ci.mjs:61-80,134-182`, treat `norm === 'skipped'` as `'red'` across **all** `BLOCKING_PREFIXES` (preserving the `ci.skippedIsPass` mutation seam), require expected matrix leg counts for matrix prefixes (`ticket-store-platform (`), and keep `watchCi` bounded with periodic `lock.heartbeat()`.

### R6 `[HIGH]` — `hollow-test` Slow-Path Fallback (`max: 3` Full-Suite Trap / `#657` Zero-Quota) & `mutate.mjs` Operator Blind Spots
- **Locations:**
  - `packages/hollow-test/lib/gate-plan.mjs:93-135,228-246`
  - `packages/hollow-test/lib/runner.mjs:188`
  - `packages/core/lib/mutate.mjs:289-294,347-365`
  - `packages/behavior-diff/lib/capture.mjs:120-137` & `lib/diff.mjs:61-66`
- **Code Evidence:**
  1. **`gate-plan.mjs:93-135,228-246`:** While `testTargetFor` (`lines 106-131`) maps 4 `EXACT` scripts plus `scripts/<name>.mjs -> scripts/test/<name>.test.mjs`, any script without an `EXACT` or same-basename test (`uncovered.length > 0`) forces the **entire PR** onto `kind: 'slow'` (`testCmd: 'node scripts/run-tests.mjs'`, ~9.5 minutes per mutant, capped at `max: Math.min(requestedMax, 3)` at `line 243`). Touching `>= 4` files when any one falls onto `slow` allocates `Math.floor(3 / 4) === 0` mutants per file, triggering `#657` (`zero-quota failure`). Conversely, `plugins/<name>/<root>.mjs` (`lines 93-95`) runs only `plugins/<name>/test` while skipping `plugins/<name>/hooks/test`. Also `runner.mjs:188` spawns mutant test commands without `sanitizeCandidateEnv` (`ADLC_MANIFEST_KEY` exposed).
  2. **`mutate.mjs:289-294,347-365`:** `collectMutants` omits `??` (`nullish coalescing`), skips unary `!` negation on `if (!isValid(x))`, applies regex operators across string literals (`"a === b"`), and uses `/g` replacement in `applyReturnNull` (`lines 355-362`), mutating multiple `return` statements simultaneously on dense lines.
  3. **`behavior-diff` (`capture.mjs:120-137`, `diff.mjs:61-66`):** Drops response HTTP headers (`content-type`, `set-cookie`, `location`), buffers unbounded response bodies in memory, and `break`s out of `diffArrays` after the first length mismatch (`line 64`), hiding element diffs in the shared prefix.
- **Remediation:**
  1. Expand `EXACT` / unit-test mappings across remaining `scripts/*.mjs` files in `gate-plan.mjs:106-131` (and ensure slow-path `mutantBudget` guarantees `>= 1` draw per changed file rather than `0`), include `plugins/<name>/hooks/test` when `plugins/<name>/*.mjs` changes (`lines 93-95`), and scrub `ADLC_MANIFEST_KEY` in `hollow-test/lib/runner.mjs:188`.
  2. Mask string/template literals before regex mutation in `packages/core/lib/mutate.mjs`, add `??` and `if (!expr)` -> `if (expr)` condition-negation operators, and replace single spans by offset instead of `/g`.
  3. Capture normalized response headers + bounded body bytes in `behavior-diff/lib/capture.mjs` and compare shared prefix elements before emitting length-delta diffs in `diffArrays`.

### R7 `[HIGH]` — Package-Level Correctness Defects & 7-Harness Capability Parity Drift
- **Package Runtime Defects:**
  1. **`packages/flail-detector/lib/parse-log.mjs:66-69,131` & `signals.mjs:132-167`:** Plaintext fallback matches `/read/i` inconsistently, `signals.mjs:132-167` compares absolute tool paths (`/repo/packages/foo/a.mjs`) against repo-relative `ticket.scope` (`packages/foo/**`) causing **100% false-positive `scope-breach`**, fails to split multi-event JSON arrays, and `readFileSync`s multi-hundred-MB session logs without byte bounds.
  2. **`packages/build-gate/lib/risk.mjs:23-40,78-79` & `bin/build-gate.mjs:23,139-152`:** `touchesAny` (`risk.mjs:38-40`) checks `globMatch(g, p)` in only one direction (`g` from ticket `scope`/`rails`, `p` from `TRUST_ROOT_PATHS`), returning `false` when a ticket specifies a concrete path inside a globbed trust root (e.g. `.adlc/tickets/T-1.json` vs `.adlc/tickets/**`), AND `MANIFEST_PATH` (`risk.mjs:26`) omits `.adlc/manifest.d/**`; meanwhile `bin/build-gate.mjs:139-152` calls `openSync(values.transcript, 'r')` without `O_NOFOLLOW` or `fstatSync(fd).isFile()` validation (blocking indefinitely on FIFOs / following symlinks, and re-opening by path via `readFileSync(values.transcript)` at `line 148` instead of reading from `fd`, alongside a stale `256 KiB` doc comment at `line 23` after `MAX_ACTIVE_CONTEXT_BYTES` moved to `8 MiB`).
  3. **`packages/consensus-fix/lib/snapshot.mjs:58-68`, `runner.mjs:52-85`, `agreement.mjs:103-109`:** Overwrites original backup when a candidate touches the same file twice; spawns candidates with no timeout or `maxBuffer`; rejects a lone passing candidate as `"divergent"` when peers failed to compile/pass tests.
  4. **`packages/context-handoff/lib/supervise-runtime.mjs:101`, `supervise.mjs:539`, `rollback.mjs:70`, `adapter.mjs:132,595`:** Kills only direct child PID (leaving grandchild test/build processes orphaned — use `-pid` process group); allows unbounded continuation loops without `--max-continuations`; writes non-atomically in `rollback.mjs:70`; burns single-use bypass grants on read-only probes.
  5. **`packages/model-ratchet/lib/walk.mjs:23,76`, `run-review.mjs:30,54-75,160`, `bin/model-ratchet.mjs:223`:** `walk.mjs` uses `statSync` (infinite symlink loop) and walks `.worktrees/`; `model-ratchet.mjs:223` (`combinedOutput`) concatenates `result.stderr` into `parseFindingsFromOutput`, matching `https://example.com:443` URLs in `stderr` as bogus `file:line` review findings.
  6. **`packages/review-calibration/lib/scorer.mjs:14-18` & `judge.mjs:196-200`:** Matches findings by `basename(file)` (`packages/a/index.mjs` falsely credits a plant in `packages/b/index.mjs`); misses OpenAI `o1`/`o3`/`o4` prefixes in `vendorFamily`.
  7. **`packages/preflight/lib/checks.mjs:17-31,100-105` & `runner.mjs:71,93,98`:** Uses hardcoded branch name `preflight-test-branch` (collides across concurrent worktrees), has no command timeout, and drops `opts.env` in `runner.mjs`.
  8. **Targeted Utility Fixes:** `packages/core/lib/llm.mjs:75` (multi-byte UTF-8 chunk split — use `StringDecoder`), `packages/tickets/lib/stores/git-tree.mjs:46` & `packages/tickets/lib/rail-existence.mjs:22` (`split('\0')` instead of NUL-safe splitting), `packages/backlog-groom/lib/io.mjs:121` (40-hex SHA-1-only regex rejecting 64-hex SHA-256 repos) & `execute.mjs:118` (resume demotion mismatch), `packages/rejection-mining/lib/gh.mjs:17` (missing `--repo` / `GH_REPO` pin), `packages/tickets/lib/edit.mjs:13` (`$EDITOR` with flags like `code --wait` fails `execFileSync(editor, [path])` — split command + flag argv via a zero-dependency quote-aware tokenizer inside `edit.mjs`).
- **7-Harness Plugin Capability Parity Drift (`scripts/router/router-model.mjs` vs `plugins/`):**
  - `ADLC_P4_ENFORCEMENT` defaults **ON** (`!== '0'`) in `claude-code`, `codex`, `copilot`, and `pi`, yet defaults **OFF** (`=== '1'`) in `cursor`, `gemini` (Antigravity `agy` / JetSki `jetski`), and `opencode`.
  - `adlc-cursor` and `adlc-opencode` check only `.adlc/manifest.jsonl` and miss greenfield segmented `.adlc/manifest.d/` evidence (whereas `adlc-herdr` already reads `.adlc/manifest.d/` per `plugins/adlc-herdr/lib/adlc-state.mjs:178-191`).
  - `adlc-copilot` (`hooks/adlc-rails-guard.mjs:218` and `hooks/adlc-build-gate.mjs:431`) lacks upward `enclosingAdlcRoot(cwd)` discovery from subdirectories and is omitted from `scripts/router/router-model.mjs` (`SIX` at `scripts/test/router-drift.test.mjs:26-33`), which also misdocuments Bash write gating for `codex`, `pi`, and `opencode`; meanwhile `plugins/adlc-gemini` ships no `.mcp.json` / MCP server registration alongside its `agy`/`jetski` projection.

---

## Part III: Performance, Latency & Token-Efficiency Bottlenecks (`P1–P5`)

### P1 `[HIGH]` — Test Runner Serialization (`58` `spawnSync` Barriers), `mutation-gate` Redundant Baselines & Slow-First `preflight`
- **Locations:**
  - `scripts/run-tests.mjs:131-194`
  - `.github/workflows/ci.yml:68`
  - `scripts/mutation-gate.mjs:230`, `packages/hollow-test/bin/hollow-test.mjs:293`, `packages/hollow-test/lib/gate-plan.mjs:221`, `packages/core/lib/syntax.mjs:100-132`
  - `scripts/preflight.mjs:46-79` & `packages/autopilot/lib/gates.mjs:50-86` (`EXPECTED_GATES`)
- **Measured Bottlenecks:**
  1. `scripts/run-tests.mjs:131-194` runs **58 sequential `spawnSync(process.execPath, ['--test', ...])` processes** one workspace at a time, runs `packages/autopilot/test/spec-coverage.test.mjs` **twice** (`packages/autopilot/test` discovery + `runAutopilotSpecGate` at `line 175`), while `ci.yml:68` runs `copilot-install-smoke.mjs` a second time right after `npm test` already ran it (`run-tests.mjs:184`).
  2. `scripts/mutation-gate.mjs` runs `hollow-test` **per package/group**: `gate-plan.mjs:221` runs a baseline test before checking whether changed lines have `0` mutants (comment/doc-only edits still pay baseline cost), `hollow-test.mjs:293` runs a second baseline before mutating, multi-file diffs union every touched test into `testCmd` (`M` mutants x `K` test files instead of per-file targeted tests), and `syntax.mjs:100-132` cold-spawns a new Node+TypeScript child process per TS mutant instead of reusing one persistent worker stdio pipe per `hollow-test` invocation.
  3. In `scripts/preflight.mjs:46-79` (after `checkToolkitFloor` at `line 118`), `buildGates` runs `tests` (minutes) -> `rail-freeze` (~1s) -> `mutation-gate` (minutes) -> `findings-ledger` (~0.3s) -> `findings-append-only` (~0.3s) -> `reviewer-directed-comments` (~0.5s), spending minutes before failing on a sub-second static gate violation.
- **Remediation:**
  1. Replace the serial loop in `scripts/run-tests.mjs` with an async bounded worker pool (`Math.min(os.availableParallelism(), 6)` concurrent child `spawn` suites with deterministic buffered output + skip duplicate `spec-coverage.test.mjs` during pass 1).
  2. In `hollow-test`, generate candidate mutants **before** running the baseline test (0-mutant comment-only changes exit `0` in `<50ms`), pass `--skip-baseline` from `mutation-gate.mjs` once a per-target baseline passes, bind each mutant to its own file's mapped test command rather than the cross-file union, and keep one persistent `syntax-check-typescript` worker child per run.
  3. Add `scripts/preflight-fast.mjs` (`npm run preflight:fast`) immediately and, once `PRE-0` completes `T-01M0Z3FN7SAS4HAH7CS63YQ0DH` (which freezes `scripts/preflight.mjs`), reorder `buildGates()` in `scripts/preflight.mjs` **and** `EXPECTED_GATES` in `packages/autopilot/lib/gates.mjs:50-86` in lockstep so `rail-freeze`, `findings-ledger`, `findings-append-only`, and `reviewer-directed-comments` fail fast in `<2s` before `tests` and `mutation-gate`.

### P2 `[HIGH]` — `merge-forecast` `O(T^2 * |F|)` Synchronous File Reads (`~198,000` `readFileSync`s) & `.worktrees/` Pollution
- **Locations:**
  - `packages/merge-forecast/lib/signals.mjs:34` (`skipDirs` in `walkTree`), `105-132` (`importRadiusIntersects`), `301-319` (`forecast`)
- **Code Evidence:**
  - `skipDirs` in `walkTree` (`signals.mjs:34`) omits `.worktrees` and `.claude`, walking nested worktree checkouts as repo files.
  - `importRadiusIntersects` (`signals.mjs:105-132`) calls `extractImports` (`readFileSync`) on every file matching `a.scope` and `b.scope` **inside the `N*(N-1)/2` pair loop** (~198,000 synchronous file reads at `T=20`), and scans all CodeGraph edges linearly per pair instead of indexing once.
- **Remediation:**
  - Add `.worktrees` and `.claude` to `skipDirs` in `walkTree`, and precompute `Map<filePath, Set<resolvedCandidates>>` + CodeGraph adjacency `Map` **once** in `O(|F| + |E|)` before the pair loop (building on `createScopeIndex` in `.adlc/specs/merge-forecast-scope-index.md`).

### P3 `[HIGH]` — `N+1` Git Subprocess Storms in `GitTreeTicketStore.load()`, `backlog-groom`, and `rejection-mining`
- **Locations:**
  - `packages/tickets/lib/stores/git-tree.mjs:92-108` (`GitTreeTicketStore.load`)
  - `packages/backlog-groom/lib/groom.mjs:95-96` & `lib/verify.mjs:279-305`
  - `packages/rejection-mining/lib/mine.mjs:27-29`
- **Code Evidence:**
  - `GitTreeTicketStore.load()` (`packages/tickets/lib/stores/git-tree.mjs:92-108`) spawns `1` `git show <rev>:<path>` process **per ticket shard** (`line 105`, `500` shards = `500` serial `spawnSync('git', ...)` calls on every `rail-freeze` run).
  - `backlog-groom` (`groom.mjs:95-96`, `verify.mjs:279-305`) spawns `git log` / `git show` per `(ticket x file)` pair with zero memoization (~15,000 git spawns on a 200-ticket backlog).
  - `rejection-mining` (`mine.mjs:27-29`) runs `1 + 50` serial `gh pr view` CLI processes instead of one batched `gh api graphql` query.
- **Remediation:**
  1. Batch `GitTreeTicketStore.load()` via a single `git cat-file --batch` invocation over all blob OIDs returned by `git ls-tree -r -z` (`500` processes -> `2` processes).
  2. Pre-index commit touches and tree paths once via `git log --name-only` + `git ls-tree -r -z` in `backlog-groom`.
  3. Fetch closed PR metadata + reviews/comments in a single paginated `gh api graphql` call in `rejection-mining`.

### P4 `[HIGH]` — `autopilot` <-> `fleet` `3x` Test/Prosecute Amplification, Uncached `npm ci` per Issue/Round & Full-Budget Single-Dispatch Strikes
- **Locations:**
  - `packages/autopilot/lib/run.mjs:29,161-162`
  - `packages/autopilot/lib/round.mjs:165,240-244`
  - `packages/autopilot/lib/fleet-args.mjs:66` (`'--max-strikes', String(budget.strikes)`)
- **Code Evidence:**
  - For a single issue, `run.mjs:29` computes `budget.strikes = Math.max(0, config.maxRounds - used)` (passing up to `15` strikes into one `fleet run` dispatch at `fleet-args.mjs:66`), `fleet` runs full build/test/prosecute gates per ticket, then `autopilot/lib/round.mjs:240-244` runs a full `npm ci --ignore-scripts`, full `npm run preflight` (re-running `npm test` + `mutation-gate`), and another full cross-model `prosecute` pass on the same tree, before CI runs them all a third time.
- **Remediation:**
  - Share a lockfile-keyed read-only `node_modules` cache (`cp -al` / reflink fallback to `npm ci --ignore-scripts`) across `autopilot` gate repos, cap per-dispatch `fleet` `--max-strikes` to `Math.min(3, budget.strikes)` so `autopilot`'s outer dead-end / flail loop can intervene early, and reuse verified tree-digest evidence between `fleet`'s merge gate and `autopilot`'s round gate when `computeTreeIdentity` is unchanged.

### P5 `[MEDIUM]` — Secondary Latency & Scaling Fixes (`coldstart --all`, `appendEntries`, `mcp-server`, `TicketService` Single-ID Fast-Path, `clusterByJaccard`)
- **Locations & Fixes:**
  1. **`packages/coldstart/lib/gate.mjs:156-205` (`checkAll` on `--all`) + LLM Loops:** Parse `.adlc/manifest` once before the ticket loop (`O(T + M)` instead of `O(T * M)` per-ticket `defaultLoadCacheEntries` calls) and run independent LLM calls through a bounded concurrency semaphore (`concurrency = 4`) across `coldstart`, `review-calibration`, `lesson-foundry`, and `rejection-mining`.
  2. **`packages/core/lib/ledger.mjs:169-175` (`appendEntries`):** `appendEntries` currently calls `readFileSync(p)` + `parseLedger(content)` unconditionally (`lines 173-174`) even when `typeof entriesOrFactory !== 'function'` (such as every `appendEntry(name, entry)` call at `line 197`), making `M` sequential appends `O(M^2)`. Guard reading/parsing behind `typeof entriesOrFactory === 'function'`.
  3. **`packages/cli/lib/mcp-server.mjs:191` & `dispatch.mjs:315`:** Switch `mcp-server.mjs` from `execFileSync` (blocks JSON-RPC stdio event loop) to async `execFile`, and dynamically `import()` modular CLI subcommands in `dispatch.mjs` instead of cold-spawning a second Node process on every `adlc <cmd>` invocation.
  4. **`packages/tickets/lib/service.mjs` & `packages/ticket-prune`:** Add `loadOne(id)` fast-path for single-ticket read operations (`ticket show`), compute `ticketHash` once per write, and pre-index git history once in `ticket-prune` (`O(K + N)` instead of `O(K * N)`).
  5. **`packages/core/lib/cluster.mjs:70-76` (`clusterByTokenSets` / Jaccard clustering):** Add inverted token index candidate filtering so token-disjoint entries skip pairwise comparison.

---

## Part IV: Architectural Consolidation & Technical-Debt Reduction (`C1–C9`)

| ID | Duplicated / Fragmented Surface | Current Copies Across Repo | Concrete Defect Caused by Drift | Target Canonical `@adlc/core` / Shared Module |
| --- | --- | --- | --- | --- |
| **C1** | File & directory locks (`8` copies) | `core/lib/primitives.mjs` (`acquireDirLock`), `core/lib/ledger.mjs` (`withLedgerLock`), `fleet/lib/lock.mjs`, `autopilot/lib/lock.mjs`, `context-handoff/lib/lock.mjs`, `tickets/lib/lock.mjs`, `tickets/lib/evidence.mjs`, `ticket-prune/lib/store.mjs`, `backlog-groom/lib/io.mjs` | Live-lock theft (`ledger.mjs:35`), 0-byte `owner.json` race (`fleet`, `context-handoff`, `primitives.mjs`), crash wedge (`tickets`, `ticket-prune`) | Leaf lock primitive in `@adlc/tickets/lib/lock.mjs` + `@adlc/core/lib/primitives.mjs` (`acquireDirLock` + `withDirLock` + `heartbeat`) |
| **C2** | Atomic file writers (`5` overwrite copies) | `core/lib/primitives.mjs` (`writeFileAtomic`), `tickets/lib/{durability,transaction}.mjs`, `fleet/lib/{status,resume}.mjs`, `autopilot/lib/{records,status}.mjs`, `context-handoff/lib/rollback.mjs` | Non-atomic writes (`context-handoff/lib/rollback.mjs:70`) and duplicated temp/rename/fsync logic | `@adlc/tickets/lib/durability.mjs` (leaf) + `packages/core/lib/primitives.mjs` (`writeFileAtomic`, `O_NOFOLLOW`/symlink-safe, `fsyncSync`) |
| **C3** | `globMatch` (`7` copies + asymmetric callers) | `core/lib/glob.mjs:37` + `6` generated copies (`core/lib/generated-glob-match.mjs:37`, `tickets/lib/generated-glob-match.mjs:37`, `plugins/adlc-{claude-code/hooks,codex/hooks,copilot/hooks,gemini}/generated-glob-match.mjs:37`), plus `core/lib/tickets.mjs:142-156` & `build-gate/lib/risk.mjs:38-40` | `tickets.mjs:142-156` (`scopesOverlap`) misses leading `**/foo.mjs` & `/` prefix boundaries; `build-gate/lib/risk.mjs:38-40` (`touchesAny`) checks `globMatch(g, p)` one-way and misses `.adlc/manifest.d/**` | `packages/core/lib/glob.mjs` + `scopesOverlap` (bundled into hooks via `esbuild`) |
| **C4** | `canonicalJson` (`6` copies) | `tickets/lib/canonical.mjs`, `core/lib/ledger.mjs:229`, `gate-manifest/lib/hmac.mjs`, `prosecute/lib/cross-model.mjs`, `autopilot/lib/digest.mjs`, `decision-layer/lib/pack.mjs` | Subtle `undefined`-property / array-hole divergence risks signature mismatch | `packages/tickets/lib/canonical.mjs` re-exported via `packages/core/lib/ledger.mjs` (`@adlc/core`) |
| **C5** | Secret patterns & redaction (`3` value-redaction surfaces) | `core/lib/secret-shapes.mjs` (`SECRET_PATTERNS`) + `core/lib/primitives.mjs:25` (`SECRET_REGEX` / `redactSecrets`), `lesson-foundry/lib/ledger-guard.mjs`, `scripts/scan-findings-ledger.mjs` | `primitives.mjs:25` hardcodes a separate `SECRET_REGEX` instead of deriving from `SECRET_PATTERNS` in `secret-shapes.mjs` | `packages/core/lib/secret-shapes.mjs` + `packages/core/lib/primitives.mjs` (`redactSecrets`) |
| **C6** | `resolveTrustedBinary` (`3` copies + `3` generated) | `core/lib/trusted-binary.mjs`, `lesson-foundry/lib/emit.mjs:128-130`, `autopilot/lib/tools.mjs:78-91`, `plugins/adlc-{claude-code,codex,copilot}/hooks/generated-trusted-binary.mjs` | `selfUid` group/world-writable bypass (`S14`) + `autopilot` symlink rejection (`R1`) | `packages/core/lib/trusted-binary.mjs` (re-exported from `@adlc/core`) |
| **C7** | `@adlc/core -> @adlc/tickets` reverse leaf duplication | `packages/core/package.json:50` depends on zero-dep leaf `@adlc/tickets`, preventing `@adlc/tickets` from importing `@adlc/core` (`scripts/ticket-readers/generate.mjs:32-34`) | Forces `@adlc/tickets` to duplicate `lock.mjs`, `canonical.mjs`, `durability.mjs`, and `generated-glob-match.mjs` | Export shared zero-dep leaf primitives (`canonical.mjs`, `durability.mjs`, `lock.mjs`, `manifest-primitives.mjs`) from `@adlc/tickets` and delegate downward from `@adlc/core` & `@adlc/gate-manifest` (strictly acyclic `@adlc/gate-manifest -> @adlc/core -> @adlc/tickets`) |
| **C8** | `SafeSandbox` parallel fork | `packages/fleet/lib/sandbox.mjs` (frozen by active tickets) + `packages/fleet/lib/safe-sandbox.mjs` (PR #1402) + `packages/gate-fuzzing/lib/sandbox.mjs` | Three separate `bwrap`/`sandbox-exec` builders (`R2`) | Shared `packages/core/lib/sandbox-runner.mjs` + fold `safe-sandbox.mjs` back into `fleet/lib/sandbox.mjs` once `PRE-0` completes `T-01M0Z3FN...`/`T-01M0Z3G8...`/`T-01M7FQ...` |
| **C9** | 7-Harness Hook Copy-Paste & `scripts/ticket-readers/generate.mjs` | 7 harness plugin hook directories + string-concatenated `generate.mjs` | Divergent P4 defaults, missing `enclosingAdlcRoot`, Cursor unbundled crash (`S5`), Claude regex drift (`S6`) | Shared `packages/hook-engine/` compiled via `esbuild` into per-harness zero-dependency hook bundles |

---

## Part V: ADLC Lifecycle Compounding & Doctrine Enhancements (`L1–L5`)

### L1 — Feed Structured Tool-Event JSONL from `fleet` Adapters into `checkFlail` (`effects.flail`) for Strike-2 Corrective Briefs
- **Current Gap:** While `packages/fleet/lib/scheduler.mjs:112-119` already calls `effects.flail({ ticket })` (wired via `live-deps.mjs:749-753` -> `checkFlail` in `packages/fleet/lib/gates.mjs:127-162`), `live-deps.mjs` writes raw unstructured adapter stdout rather than normalized tool-call JSONL events (`parse-log.mjs`), and when `flail` trips (`repeated-error`, `scope-violation`, `edit-churn`, `size`, `budget`), `scheduler.mjs` lacks a corrective anti-flail brief injection path for Strike 2.
- **Enhancement:** Emit normalized ADLC tool-event JSONL records per strike from `fleet` adapter runs, fix `flail-detector`'s repo-relative `scope-violation` path normalization (`R7.1`), and enrich `checkFlail` (`fleet/lib/gates.mjs:127-162`) + `effects.flail` in `scheduler.mjs` so thrashing builders (`repeated-error`, `edit-churn`, `scope-violation`) receive a sanitized anti-flail corrective brief on Strike 2 or abort/escalate early instead of burning remaining strikes.

### L2 — Wire `fleet` Build Outcomes into `model-router` Priors, Harden `density.mjs` & Weight Critical-Path Token Budgets
- **Current Gap:**
  1. `packages/fleet/lib/quartermaster.mjs:187-188` feeds `readManifestForest(adlcDir)` into `buildPriors(entries)` (`packages/model-router/lib/priors.mjs:24-52`), which filters for `entry.type === 'build'` with top-level `{ model, category, firstPass }` where `bestTierFromPriors` (`priors.mjs:88-94`) requires `model` to literally equal `'cheap' | 'mid' | 'frontier'`. Yet `gate-manifest` `record()` stores payload fields inside `entry.data` and `packages/fleet` never emits `build` outcome entries at all — leaving `priors` permanently empty (`n = 0`).
  2. `packages/model-router/lib/assign.mjs:45-66,108-120` uses static `DEFAULT_TIER_BUDGET` ceilings (`50k`/`150k`/`400k`, noting `#272`) and gives critical-path (`float === 0`, `direct`, `'mid'`) tickets only `150,000` tokens compared to `450,000` tokens on non-critical-path `ladder` tickets.
  3. `packages/model-router/lib/density.mjs:48-60` (`railDensity`) counts any non-empty `rails[]` string (`['README.md', 'LICENSE']`) toward `CHEAP_TIER_MIN_DENSITY` (`0.5`), allowing non-test or out-of-domain dummy rails to route multi-file tickets onto `'cheap'`.
- **Enhancement:** Have `fleet/lib/scheduler.mjs` record `gate: 'build'` outcome entries (`{ tier, model, provider, category, firstPass, strikes, usage }`), update `priors.mjs` to read `entry.data` (mapping seat `tier` + empirical token spend), weight `assign.mjs` budgets by empirical spend priors and critical-path fan-out (`float === 0`), and restrict `density.mjs` numerator credit to verifiable executable test/contract rails.

### L3 — Close the P7 Compounding Loop (`rejection-mining` & `lesson-foundry` Outputs -> Live P1/P2/P4/P5 Gates & Flag-Aware `skill-rot`)
- **Current Gap:** `@adlc/rejection-mining` (`packages/rejection-mining/bin/rejection-mining.mjs:15-25`) and `@adlc/lesson-foundry` (`packages/lesson-foundry/lib/emit.mjs`) emit four artifact types that **zero gates read**:
  1. `.adlc/lenses/<slug>.md` (emitted by `rejection-mining`) — `packages/core/lib/prosecutor.mjs:75-81` (`LENSES`) defines only the 5 static built-in lenses and `packages/prosecute/lib/run.mjs` ignores `.adlc/lenses/`.
  2. `.adlc/lessons/interrogation-template.md` (emitted by `lesson-foundry`) — neither `coldstart`, `premortem`, nor `spec-lint` loads it.
  3. `.adlc/lessons/check-<slug>.mjs` (emitted by `lesson-foundry`) — neither `preflight` nor `build-gate` discovers or executes promoted deterministic checks.
  4. `.agents/skills/<name>/SKILL.md` (emitted by `lesson-foundry`) — `packages/skill-rot/lib/{extract-claims,verify-claims}.mjs` checks file paths and `package.json` scripts while ignoring drifted CLI `--flags`.
- **Enhancement:** Freeze `.adlc/lessons/**` and `.adlc/lenses/**` as trust roots (`tier.mjs` + `REPO_TRUST_ROOTS` + `CODEOWNERS`), load `.adlc/lenses/*.md` and `.adlc/lessons/interrogation-template.md` **from `trustedBase`** (`git show <trustedBase>:<path>` in PR/CI contexts, wrapped in `@adlc/core`'s `fence(..., { bias: 'head' })`) as additive P5 lenses in `prosecutor.mjs`/`prosecute` and P1/P2 checklists in `premortem`/`coldstart`, execute `trustedBase`-verified `.adlc/lessons/check-*.mjs` guards inside `sandbox-runner.mjs` (`ADLC_MANIFEST_KEY` stripped, network denied) during `preflight`, and add `--help` CLI flag verification to `packages/skill-rot/lib/{extract-claims,verify-claims}.mjs`.

### L4 — Universal `onUsage` Spend Accounting Across All 8 Non-Prosecute LLM Packages & Live `--record` Evidence Emission
- **Current Gap:** Only `prosecute` wires `onUsage` spend capture into `gate-manifest`, while `spec-lint`, `coldstart`, `premortem`, `parallax`, `lesson-foundry` (`lib/llm.mjs`), `rejection-mining` (`lib/llm.mjs`), `review-calibration` (`lib/judge.mjs`), and `consensus-fix` (`bin/consensus-fix.mjs`) drop token/cost usage; and `premortem`, `parallax`, `merge-forecast`, and `review-calibration` omit automatic manifest recording in standard runs, starving `recall`, `model-router`, and `quartermaster` of calibration data.
- **Enhancement:** Thread `onUsage` through `packages/core/lib/llm.mjs` across all 8 LLM packages into `gate-manifest` entries (declaring `@adlc/gate-manifest` in `packages/{lesson-foundry,rejection-mining,review-calibration,merge-forecast,consensus-fix}/package.json`), auto-record `premortem` and `parallax` runs **whenever `--ticket <id>` is supplied** (preserving `#709` so unbound P1 records are never emitted), and auto-record repo-level `merge-forecast` and `review-calibration` runs (with `--no-record` opt-out) when an initialized `.adlc/manifest.jsonl` / `.adlc/manifest.d/` store is present.

### L5 — Reconcile Duplicate `ADR-0010`s, Stale ADR Claims & Root Doctrine Docs
- **Current Gap:**
  1. Three distinct ADRs share number `0010`: `docs/adr/0010-adlc-fleet-orchestration.md`, `docs/adr/0010-first-party-curl-installer.md`, and `docs/adr/0010-sharded-ticket-store.md`.
  2. `docs/adr/0001-codex-native-adlc-integration.md`, `0002-adlc-command-reconciliation.md`, `0003-adlc-claude-code-plugin.md`, and `0007-multimodel-adversarial-review.md` contain superseded claims (flat `.adlc/tickets.json`, separate `adlc-*` bins only, unsegmented `.adlc/manifest.jsonl`, static single-author provider assumptions) without `Amended-by` / `Superseded-by` cross-links.
  3. `AGENTS.md:201-208` states plugin enforcement cores are cross-model tiered (`tier.mjs` currently omits them — `S7`), and `CONVENTIONS.md` / `ADLC.md` do not yet list `sandbox-runner.mjs` and `packages/hook-engine` alongside `@adlc/core` shared primitives.
- **Enhancement:** Renumber the colliding `0010` ADRs (`0017`, `0018` with canonical index in `docs/adr/README.md`), add `Amended-by` / `Superseded-by` headers to `0001`, `0002`, `0003`, and `0007`, and synchronize `ADLC.md`, `AGENTS.md`, and `CONVENTIONS.md` with the hardened post-resolution architecture.
