# Specification: ADLC v0.3 Modernization — Wave 4 (Gate Promotion & Core Consolidation) and Wave 5 (Plugin Hook Codegen)

## Context & Problem Statement

Following the completion and merge of **Wave 1** (`#1238` — Security & Correctness Fixes), **Wave 2** (`#1239` — Core Shared Primitives Extraction), and **Wave 3** (`#1240` — Gate & Lifecycle Consolidation), two major categories of duplication and unpromoted gate logic remain on `origin/main` (`3d96f9ff`):

1. **Wave 4 — Core Process Probes, Canonical Hashing, Diff-Scoped Mutation Planning & Findings-Ledger Git-Boundary Guards:**
   - **Process Identity & Lock Probing Duplication:** `packages/fleet/lib/proc.mjs` (`pidAlive`, `procStartTimeOf`, `thisHost`, `selfIdentity`, `lockProbes`) and `packages/autopilot/lib/lock.mjs` (`pidStartTimeOf`, `pidAlive`, `selfIdentity`, `defaultProbes`) independently implement `/proc/<pid>/stat` field-22 `starttime` and `ps -o lstart=` PID-reuse process identity probing.
   - **Unpromoted Diff-Scoped Mutation Planner:** `scripts/mutation-gate.mjs` (`564` LOC) embeds pure diff-scoped fast test-target mapping and proportional mutant-budget planning (`testTargetFor`, `classify`, `mutantBudget`, `mutableChangedFiles`, `hollowTestWouldMutate`, `MUTANTS_PER_CHANGED_FILE`, `HOLLOW_WINDOW_MS`, `FAST_RUN_TIMEOUT_MS`, `SLOW_RUN_TIMEOUT_MS`, `SURVIVOR_GUIDANCE`) that external consumers of `@adlc/hollow-test` cannot import or invoke.
   - **Canonical JSON & SHA-256 Duplication in `@adlc/decision-layer`:** `packages/decision-layer/lib/canonical.mjs` re-implements recursive key-sorted `canonicalJson` and `sha256` hashing that already exist in `@adlc/core` (`packages/core/lib/ledger.mjs`, re-exported by `packages/core/index.mjs`).
   - **Unpromoted ADR 0014 Findings-Ledger Git-Boundary Guards:** `scripts/scan-findings-ledger.mjs` (`79` LOC) and `scripts/guard-findings-ledger-append-only.mjs` (`140` LOC) implement the committed `.adlc/findings.jsonl` secret/dump scanner and append-only merge-base prefix guard as repo-local scripts rather than reusable library modules in `@adlc/lesson-foundry`.

2. **Wave 5 — Plugin Hook Codegen & Elimination of Hand-Inlined `KEEP IN SYNC` Copies:**
   - Installed plugin hooks (`plugins/adlc-codex/hooks/`, `plugins/adlc-copilot/hooks/`, `plugins/adlc-claude-code/hooks/`) execute from deployed plugin directories without `node_modules`. While `scripts/ticket-readers/generate.mjs` already generates `generated-ticket-reader.mjs`, `generated-active-ticket.mjs`, and `generated-glob-match.mjs` from single canonical sources, three large `KEEP IN SYNC` families (~950 LOC total) remain hand-inlined across the plugin hooks:
     - **Shell Classifier (`~500` LOC duplicated):** `plugins/adlc-codex/hooks/adlc-rails-guard.mjs` and `plugins/adlc-copilot/hooks/adlc-rails-guard.mjs` each inline ~250 lines of `packages/core/lib/shell.mjs` (`shellTokens`, `shellHasMutation`, `hasUnquotedFileRedirect`, `shellHasOpaqueMutation`, `shellIsPositivelyReadOnly`, `shellHasWriteOption`, `shellChangesCwd`, `shellHasExpansion`, `collectShellPaths`, `collectPatchPaths`, `looksPathLike`, `looksBarePathLike`, `keyValuePath`).
     - **Risk-Tier Classifier (`~150` LOC duplicated):** `plugins/adlc-codex/hooks/adlc-lifecycle.mjs` and `plugins/adlc-copilot/hooks/adlc-lifecycle.mjs` each inline `packages/core/lib/risk-tier.mjs` (`RISK_TIER_PATTERNS`, `matchRiskTier`, `classifyRiskTier`, `filesOverlapOrUnscoped`, `decideAdversarialReviewNotice`).
     - **Trusted Binary Resolver (`~300` LOC duplicated):** `plugins/adlc-claude-code/hooks/adlc-hook.mjs`, `plugins/adlc-codex/hooks/adlc-handoff-gate.mjs`, and `plugins/adlc-copilot/hooks/adlc-build-gate.mjs` each hand-inline `resolveTrustedBinary`, `ownershipRejection`, `ancestorDirs`, `candidateAncestors`, `binaryCandidates`, `candidateStats`, `candidateRejection`, and `untrustedBinaryReason`.

## Non-Goals & Trust-Root Constraints

1. Do not modify any file in `DEFAULT_IMMUTABLE_TRUST_ROOTS` (`packages/rails-guard/lib/ci/trust-roots.mjs`), `REPO_TRUST_ROOTS` (`scripts/rails-guard-ci.mjs`), `TRUST_ROOT_FILES` / `ENFORCEMENT_PREFIXES` / `PRODUCER_PREFIXES` (`packages/prosecute/lib/tier.mjs`), or any active ticket rail (`t.completed !== true` on `origin/main`).
2. Preserve all `registerSeams(...)` mutation seams in `packages/autopilot/lib/lock.mjs` so `AUTOPILOT_GATE_FULL=1 node --test packages/autopilot/test/spec-coverage.test.mjs` continues to pass with 100% seam kill coverage.
3. Preserve all existing CLI flags, exit codes (`0`, `1`, `2`), and named module exports across `packages/fleet`, `packages/autopilot`, `packages/hollow-test`, `packages/decision-layer`, `packages/lesson-foundry`, `scripts/mutation-gate.mjs`, `scripts/scan-findings-ledger.mjs`, `scripts/guard-findings-ledger-append-only.mjs`, and all plugin hooks.
4. Whenever `@adlc/core` sources change, regenerate `plugins/adlc-cursor/bin/adlc-mcp-wrapper.bundle.mjs` via `npm run build:cursor-mcp` so `scripts/test/ticket-store-boundary.test.mjs` passes.
5. Stage `@adlc/core` export additions (`W4-T1`) in a prerequisite ticket before consumer package refactors (`W4-T5`) so `agb` child worktrees whose symlinked `node_modules/@adlc/core` points to the parent worktree always resolve the new `@adlc/core` exports at test time.

---

## Wave 4 Architecture & Ticket Breakdown

### `W4-T1`: Add Process Identity & Lock Probe Primitives (`thisHost`, `pidAlive`, `procStartTimeOf`, `selfProcessIdentity`, `defaultLockProbes`) to `@adlc/core`

- **Scope:**
  - `packages/core/lib/proc.mjs`
  - `packages/core/index.mjs`
  - `packages/core/index.d.ts`
  - `packages/core/test/proc.test.mjs`
  - `plugins/adlc-cursor/bin/adlc-mcp-wrapper.bundle.mjs`
- **Rails:**
  - `packages/core/test/core.test.mjs`
  - `scripts/test/ticket-store-boundary.test.mjs`
- **Edges:** `[{ "to": "W4-T5" }]`
- **Design:**
  - Create `packages/core/lib/proc.mjs` exporting `thisHost()`, `pidAlive(pid)`, `procStartTimeOf(pid, opts)`, `selfProcessIdentity()`, and `defaultLockProbes()`.
  - `selfProcessIdentity()` returns `{ pid: process.pid, host: thisHost(), procStartTime: start, pidStartTime: start }` and `defaultLockProbes()` returns `{ host: thisHost(), pidAlive, procStartTimeOf, pidStartTimeOf: procStartTimeOf }` so both `@adlc/fleet` (`procStartTime` / `procStartTimeOf`) and `@adlc/autopilot` (`pidStartTime` / `pidStartTimeOf`) field conventions are satisfied out of the box.
  - Re-export `thisHost`, `pidAlive`, `procStartTimeOf`, `selfProcessIdentity`, and `defaultLockProbes` from `packages/core/index.mjs` and declare their types in `packages/core/index.d.ts`.
  - Add unit tests in `packages/core/test/proc.test.mjs` covering `thisHost`, `pidAlive`, `procStartTimeOf` (Linux `/proc/<pid>/stat` field 22 with spaces/parens in `comm`, `ps -o lstart=` fallback, dead/invalid PID handling), `selfProcessIdentity`, and `defaultLockProbes`.
  - Rebuild `plugins/adlc-cursor/bin/adlc-mcp-wrapper.bundle.mjs` via `npm run build:cursor-mcp`.

### `W4-T2`: Promote Diff-Scoped Fast Test Target & Mutant Budget Planner from `scripts/mutation-gate.mjs` to `@adlc/hollow-test`

- **Scope:**
  - `packages/hollow-test/lib/gate-plan.mjs`
  - `packages/hollow-test/test/gate-plan.test.mjs`
  - `scripts/mutation-gate.mjs`
- **Rails:**
  - `scripts/test/mutation-gate.test.mjs`
- **Design:**
  - Create `packages/hollow-test/lib/gate-plan.mjs` exporting `ROOT` (`join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')`), `MUTANTS_PER_CHANGED_FILE`, `HOLLOW_WINDOW_MS`, `FAST_RUN_TIMEOUT_MS`, `SLOW_RUN_TIMEOUT_MS`, `SURVIVOR_GUIDANCE`, `SOURCE_GLOBS`, `hollowTestWouldMutate(file)`, `testTargetFor(file, root = ROOT)`, `mutableChangedFiles(changed, root = ROOT)`, `classify(changed, requestedMax, root = ROOT)`, and `mutantBudget(decision, { runMs = null, windowMs = HOLLOW_WINDOW_MS, perRunTimeoutMs = FAST_RUN_TIMEOUT_MS } = {})` (implementing `hollowTestWouldMutate(file)` via `isMutableSource(file, { sourceGlobs: SOURCE_GLOBS })` from `./targets.mjs`).
  - Refactor `scripts/mutation-gate.mjs` to import and re-export (`export { ... } from '../packages/hollow-test/lib/gate-plan.mjs'`) those planner symbols while retaining and exporting `GENERATED_VERSION_FILES`, `declarationArgs`, `measureRun`, and `main` in `scripts/mutation-gate.mjs` (preserving all 16 named exports imported by `scripts/test/mutation-gate.test.mjs`).
  - Add comprehensive unit tests in `packages/hollow-test/test/gate-plan.test.mjs` covering every branch of `hollowTestWouldMutate`, `testTargetFor`, `classify`, `mutantBudget`, and `mutableChangedFiles`.

### `W4-T3`: Consolidate `@adlc/decision-layer` Canonical JSON & SHA-256 Hashing onto `@adlc/core`

- **Scope:**
  - `packages/decision-layer/lib/canonical.mjs`
  - `packages/decision-layer/test/canonical.test.mjs`
- **Rails:**
  - `packages/decision-layer/test/evaluate.test.mjs`
  - `packages/decision-layer/test/record.test.mjs`
- **Design:**
  - Refactor `packages/decision-layer/lib/canonical.mjs` to import and re-export `canonicalJson` and `sha256` from `@adlc/core` (`packages/core/lib/ledger.mjs`), delegating `canonicalHash(value)` to `sha256(canonicalJson(value))` and `canonicalBytes(value)` to `Buffer.byteLength(canonicalJson(value), 'utf8')`.
  - Add `packages/decision-layer/test/canonical.test.mjs` verifying key-order invariance, nested array/object canonicalization, UTF-8 byte length calculation, and parity with `@adlc/core`.

### `W4-T4`: Promote ADR 0014 Findings-Ledger Git-Boundary Scanner & Append-Only Guard to `@adlc/lesson-foundry`

- **Scope:**
  - `packages/lesson-foundry/lib/ledger-guard.mjs`
  - `packages/lesson-foundry/test/ledger-guard.test.mjs`
  - `scripts/scan-findings-ledger.mjs`
  - `scripts/guard-findings-ledger-append-only.mjs`
- **Rails:**
  - `scripts/test/scan-findings-ledger.test.mjs`
  - `scripts/test/guard-findings-ledger-append-only.test.mjs`
  - `scripts/test/entry-guard-space-path.test.mjs`
- **Design:**
  - Create `packages/lesson-foundry/lib/ledger-guard.mjs` exporting `LEDGER`, `scanFindingsLedger(ledger)`, `baseLedger(baseRef, run)`, `headLedgerText(read, exists)`, `appendOnlyViolations(baseText, headText)`, and `guardFindingsLedgerAppendOnly(baseRef, opts)`.
  - Update `scripts/scan-findings-ledger.mjs` and `scripts/guard-findings-ledger-append-only.mjs` to import and re-export (`LEDGER`, `scanFindingsLedger as scan`, `baseLedger`, `headLedgerText`, `appendOnlyViolations`, `guardFindingsLedgerAppendOnly as guard`) from `../packages/lesson-foundry/lib/ledger-guard.mjs` while keeping their `pathToFileURL(process.argv[1]).href` CLI entry guards, exact `scan-findings-ledger:` and `guard-findings-ledger-append-only:` stdout/stderr diagnostic prefixes/wording, and exit codes (`0`, `1`, `2`) intact.
  - Add unit tests in `packages/lesson-foundry/test/ledger-guard.test.mjs` covering clean, malformed, secret-bearing, rewritten, and truncated ledger scenarios.

### `W4-T5`: Delegate `@adlc/fleet` and `@adlc/autopilot` Process Identity & Lock Probes to `@adlc/core`

- **Scope:**
  - `packages/fleet/lib/proc.mjs`
  - `packages/autopilot/lib/lock.mjs`
- **Rails:**
  - `packages/fleet/test/lock-recovery.test.mjs`
  - `packages/fleet/test/lock-reclaim-race.test.mjs`
  - `packages/autopilot/test/lock.test.mjs`
  - `packages/autopilot/test/spec-coverage.test.mjs`
- **Design:**
  - Replace `packages/fleet/lib/proc.mjs` with pure `@adlc/core` re-exports (`export { thisHost, pidAlive, procStartTimeOf, selfProcessIdentity as selfIdentity, defaultLockProbes as lockProbes } from '@adlc/core';`).
  - Refactor `packages/autopilot/lib/lock.mjs` to import and re-export `pidAlive`, `procStartTimeOf as pidStartTimeOf`, `selfProcessIdentity as selfIdentity`, and `defaultLockProbes as defaultProbes` from `@adlc/core` while preserving all `registerSeams('lock', ...)` entries and lock lifecycle functions (`lockPath`, `acquireLock`, `releaseLock`, `readLock`, `inspectLock`) unchanged.

---

## Wave 5 Architecture & Ticket Breakdown

### `W5-T1`: Canonicalize `@adlc/core` Trusted Binary Resolver and Extend `scripts/ticket-readers/generate.mjs` to Emit `generated-shell.mjs`, `generated-risk-tier.mjs`, and `generated-trusted-binary.mjs`

- **Scope:**
  - `packages/core/lib/trusted-binary.mjs`
  - `packages/core/lib/shell.mjs`
  - `packages/core/lib/risk-tier.mjs`
  - `packages/core/lib/generated-glob-match.mjs`
  - `packages/core/index.mjs`
  - `packages/core/index.d.ts`
  - `packages/core/test/trusted-binary.test.mjs`
  - `scripts/ticket-readers/generate.mjs`
  - `scripts/test/ticket-reader-generation.test.mjs`
  - `plugins/adlc-cursor/bin/adlc-mcp-wrapper.bundle.mjs`
  - `plugins/adlc-codex/hooks/generated-shell.mjs`
  - `plugins/adlc-copilot/hooks/generated-shell.mjs`
  - `plugins/adlc-codex/hooks/generated-risk-tier.mjs`
  - `plugins/adlc-copilot/hooks/generated-risk-tier.mjs`
  - `plugins/adlc-claude-code/hooks/generated-trusted-binary.mjs`
  - `plugins/adlc-codex/hooks/generated-trusted-binary.mjs`
  - `plugins/adlc-copilot/hooks/generated-trusted-binary.mjs`
- **Rails:**
  - `packages/core/test/core.test.mjs`
  - `packages/core/test/risk-tier.test.mjs`
  - `scripts/test/ticket-store-boundary.test.mjs`
- **Edges:** `[{ "to": "W5-T2" }]`
- **Design:**
  - Create `packages/core/lib/trusted-binary.mjs` (`// GENERATED-TRUSTED-BINARY SOURCE.`) exporting `resolveTrustedBinary`, `ownershipRejection`, `ancestorDirs`, `candidateAncestors`, `binaryCandidates`, `candidateStats`, `candidateRejection`, and `untrustedBinaryReason`. Re-export from `packages/core/index.mjs` and `packages/core/index.d.ts`.
  - Add `// GENERATED-SHELL SOURCE.` header to `packages/core/lib/shell.mjs`.
  - Add `'packages/core/lib/generated-glob-match.mjs'` to the `generated-glob-match` outputs list in `scripts/ticket-readers/generate.mjs` (`source: 'packages/core/lib/glob.mjs'`), and update `packages/core/lib/risk-tier.mjs` to start with `// GENERATED-RISK-TIER SOURCE.` and `import { globMatch } from './generated-glob-match.mjs'`.
  - Extend `ARTIFACTS` in `scripts/ticket-readers/generate.mjs` to generate `generated-shell.mjs`, `generated-risk-tier.mjs`, and `generated-trusted-binary.mjs`, and add byte-for-byte parity assertions in `scripts/test/ticket-reader-generation.test.mjs`.
  - Run `npm run build:cursor-mcp` to keep `plugins/adlc-cursor/bin/adlc-mcp-wrapper.bundle.mjs` in sync.

### `W5-T2`: Eliminate Hand-Inlined Shell Classifiers & Risk-Tier Matchers in `adlc-codex` and `adlc-copilot` Hooks

- **Scope:**
  - `plugins/adlc-codex/hooks/adlc-rails-guard.mjs`
  - `plugins/adlc-copilot/hooks/adlc-rails-guard.mjs`
  - `plugins/adlc-codex/hooks/adlc-lifecycle.mjs`
  - `plugins/adlc-copilot/hooks/adlc-lifecycle.mjs`
  - `packages/core/test/shell.test.mjs`
  - `plugins/adlc-copilot/test/shell-drift.test.mjs`
- **Rails:**
  - `plugins/adlc-codex/hooks/test/shell-quoting.test.mjs`
  - `plugins/adlc-codex/hooks/test/review-notice.test.mjs`
  - `plugins/adlc-copilot/hooks/test/review-notice.test.mjs`
  - `plugins/adlc-copilot/test/rails-guard-contract.test.mjs`
- **Edges:** `[{ "to": "W5-T3" }]`
- **Design:**
  - Replace the ~250-line hand-inlined shell classifier blocks in `plugins/adlc-codex/hooks/adlc-rails-guard.mjs` and `plugins/adlc-copilot/hooks/adlc-rails-guard.mjs` with imports (and re-exports) from `./generated-shell.mjs`.
  - Delete the hand-inlined `RISK_TIER_PATTERNS`, `matchRiskTier`, `classifyRiskTier`, `filesOverlapOrUnscoped`, and `decideAdversarialReviewNotice` definitions in `plugins/adlc-codex/hooks/adlc-lifecycle.mjs` and `plugins/adlc-copilot/hooks/adlc-lifecycle.mjs`, import and re-export `{ RISK_TIER_PATTERNS, matchRiskTier, classifyRiskTier, decideAdversarialReviewNotice }` from `./generated-risk-tier.mjs`, and retain `export { globMatch } from './generated-glob-match.mjs';`.
  - Update `packages/core/test/shell.test.mjs` and `plugins/adlc-copilot/test/shell-drift.test.mjs` to verify `./generated-shell.mjs` and `./generated-risk-tier.mjs` wiring and byte-for-byte canonical parity, and verify `node scripts/copilot-install-smoke.mjs` passes.

### `W5-T3`: Eliminate Hand-Inlined Trusted Binary Resolvers Across `adlc-claude-code`, `adlc-codex`, and `adlc-copilot` Hooks

- **Scope:**
  - `plugins/adlc-claude-code/hooks/adlc-hook.mjs`
  - `plugins/adlc-codex/hooks/adlc-handoff-gate.mjs`
  - `plugins/adlc-copilot/hooks/adlc-build-gate.mjs`
  - `plugins/adlc-claude-code/hooks/test/handoff-continuation-start.test.mjs`
  - `plugins/adlc-claude-code/hooks/test/handoff-secret-scrub.test.mjs`
  - `plugins/adlc-codex/hooks/test/handoff-deny.test.mjs`
  - `plugins/adlc-codex/hooks/test/handoff-secret-scrub.test.mjs`
- **Rails:**
  - `plugins/adlc-claude-code/hooks/test/adlc-trusted-spawn.test.mjs`
  - `plugins/adlc-codex/hooks/test/trusted-binary-root.test.mjs`
  - `plugins/adlc-copilot/hooks/test/trusted-binary-root.test.mjs`
- **Design:**
  - Replace the hand-inlined `resolveTrustedBinary`, `ownershipRejection`, `ancestorDirs`, `candidateAncestors`, `binaryCandidates`, `candidateStats`, `candidateRejection`, and `untrustedBinaryReason` definitions in `plugins/adlc-claude-code/hooks/adlc-hook.mjs`, `plugins/adlc-codex/hooks/adlc-handoff-gate.mjs`, and `plugins/adlc-copilot/hooks/adlc-build-gate.mjs` with imports and re-exports from `./generated-trusted-binary.mjs`.
  - Update `isolatedPluginDir(t)` in `handoff-continuation-start.test.mjs`, `handoff-secret-scrub.test.mjs`, and `handoff-deny.test.mjs` to include `generated-trusted-binary.mjs`.

---

## Acceptance Criteria

- **AC-1 (`W4-T1` — Process Identity & Lock Probe Primitives in `@adlc/core`):** `packages/core/lib/proc.mjs` exports `thisHost`, `pidAlive`, `procStartTimeOf`, `selfProcessIdentity`, and `defaultLockProbes` (re-exported from `@adlc/core` and `packages/core/index.d.ts`) and `plugins/adlc-cursor/bin/adlc-mcp-wrapper.bundle.mjs` is rebuilt; verify: `node --test packages/core/test/proc.test.mjs packages/core/test/core.test.mjs scripts/test/ticket-store-boundary.test.mjs`
- **AC-2 (`W4-T2` — Diff-Scoped Mutation Planner in `@adlc/hollow-test`):** `packages/hollow-test/lib/gate-plan.mjs` exports `testTargetFor`, `classify`, `mutantBudget`, `mutableChangedFiles`, `hollowTestWouldMutate`, `MUTANTS_PER_CHANGED_FILE`, `HOLLOW_WINDOW_MS`, `FAST_RUN_TIMEOUT_MS`, `SLOW_RUN_TIMEOUT_MS`, and `SURVIVOR_GUIDANCE`, and `scripts/mutation-gate.mjs` delegates to and re-exports them; verify: `node --test packages/hollow-test/test/gate-plan.test.mjs scripts/test/mutation-gate.test.mjs`
- **AC-3 (`W4-T3` — Canonical Hashing Consolidation in `@adlc/decision-layer`):** `packages/decision-layer/lib/canonical.mjs` delegates `canonicalJson` and `sha256` to `@adlc/core` while preserving `canonicalHash` and `canonicalBytes`; verify: `node --test packages/decision-layer/test/canonical.test.mjs packages/decision-layer/test/evaluate.test.mjs packages/decision-layer/test/record.test.mjs`
- **AC-4 (`W4-T4` — Findings-Ledger Git-Boundary Guards in `@adlc/lesson-foundry`):** `packages/lesson-foundry/lib/ledger-guard.mjs` exports `LEDGER`, `scanFindingsLedger`, `baseLedger`, `headLedgerText`, `appendOnlyViolations`, and `guardFindingsLedgerAppendOnly`, and `scripts/scan-findings-ledger.mjs` and `scripts/guard-findings-ledger-append-only.mjs` delegate to it; verify: `node --test packages/lesson-foundry/test/ledger-guard.test.mjs scripts/test/scan-findings-ledger.test.mjs scripts/test/guard-findings-ledger-append-only.test.mjs scripts/test/entry-guard-space-path.test.mjs`
- **AC-5 (`W4-T5` — `@adlc/fleet` & `@adlc/autopilot` Lock Probe Consolidation):** `packages/fleet/lib/proc.mjs` and `packages/autopilot/lib/lock.mjs` delegate `thisHost`, `pidAlive`, `procStartTimeOf`/`pidStartTimeOf`, `selfIdentity`, and `lockProbes`/`defaultProbes` to `@adlc/core` while preserving all autopilot mutation seams; verify: `node --test packages/fleet/test/lock-recovery.test.mjs packages/fleet/test/lock-reclaim-race.test.mjs packages/autopilot/test/lock.test.mjs packages/autopilot/test/spec-coverage.test.mjs`
- **AC-6 (`W5-T1` — Codegen for Shell, Risk-Tier & Trusted-Binary Hook Modules):** `scripts/ticket-readers/generate.mjs --check` verifies byte-for-byte identity of `generated-shell.mjs`, `generated-risk-tier.mjs`, and `generated-trusted-binary.mjs` across `adlc-claude-code`, `adlc-codex`, and `adlc-copilot`; verify: `node scripts/ticket-readers/generate.mjs --check && node --test packages/core/test/trusted-binary.test.mjs packages/core/test/core.test.mjs packages/core/test/risk-tier.test.mjs scripts/test/ticket-reader-generation.test.mjs scripts/test/ticket-store-boundary.test.mjs`
- **AC-7 (`W5-T2` — Shell Classifier & Risk-Tier Deduplication in `adlc-codex` and `adlc-copilot`):** `plugins/adlc-codex/hooks/adlc-rails-guard.mjs`, `plugins/adlc-copilot/hooks/adlc-rails-guard.mjs`, `plugins/adlc-codex/hooks/adlc-lifecycle.mjs`, and `plugins/adlc-copilot/hooks/adlc-lifecycle.mjs` import from `./generated-shell.mjs` and `./generated-risk-tier.mjs` with zero hand-inlined copies; verify: `node --test packages/core/test/shell.test.mjs plugins/adlc-copilot/test/shell-drift.test.mjs plugins/adlc-codex/hooks/test/shell-quoting.test.mjs plugins/adlc-codex/hooks/test/review-notice.test.mjs plugins/adlc-copilot/hooks/test/review-notice.test.mjs plugins/adlc-copilot/test/rails-guard-contract.test.mjs && node scripts/copilot-install-smoke.mjs`
- **AC-8 (`W5-T3` — Trusted Binary Resolver Deduplication Across `adlc-claude-code`, `adlc-codex`, and `adlc-copilot`):** `adlc-hook.mjs`, `adlc-handoff-gate.mjs`, and `adlc-build-gate.mjs` import and re-export `resolveTrustedBinary` and its ownership helpers from `./generated-trusted-binary.mjs`; verify: `node --test plugins/adlc-claude-code/hooks/test/adlc-trusted-spawn.test.mjs plugins/adlc-codex/hooks/test/trusted-binary-root.test.mjs plugins/adlc-copilot/hooks/test/trusted-binary-root.test.mjs plugins/adlc-claude-code/hooks/test/handoff-continuation-start.test.mjs plugins/adlc-claude-code/hooks/test/handoff-secret-scrub.test.mjs plugins/adlc-codex/hooks/test/handoff-deny.test.mjs plugins/adlc-codex/hooks/test/handoff-secret-scrub.test.mjs`
