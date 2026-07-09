# OpenCode Integration Continuation — land Phase 4, flush install friction, absorb the 1.17.17 surface

Status: PROPOSED (P0/P1 — evaluation + execution plan)
Branch: `opencode-integration`
Supersedes nothing; continues `docs/specs/opencode-native-flush.md` (Phases 1–3 merged).
Baseline verified 2026-07-09 against `@opencode-ai/plugin` / `@opencode-ai/sdk` **1.17.17**
(published same day; upstream repo moved `sst/opencode` → `anomalyco/opencode`).

## Where we stand (evaluation, 2026-07-09)

| Flush-spec phase | State | Evidence |
| --- | --- | --- |
| Phase 1 — hook correctness, enforce-by-default, native skills | **MERGED** | PR #109; `scripts/opencode-live-deny.mjs` required in CI |
| Phase 2 — shell gating, build-gate backstop, `file.edited` backstop, dormant `permission.ask` | **MERGED** | PR #116 |
| Phase 3 — context injection, `tool.definition` rail notice, flail advisory, statusline toast | **MERGED** | PR #117 |
| Phase 4.1/4.2 — live keyless bridge + native `adlc_gate` tool | **BUILT, UNCOMMITTED** | `.worktrees/opencode-native-flush` (branch `opencode-native-phase4`): +1133/−58 across 12 files, 171/171 tests green, live harness `scripts/opencode-live-tool.mjs` + CI job written. Never committed, never prosecuted, no PR. |
| Phase 4.3/“4b” — deterministic P5 runner (`adlc_prosecute` tool) | **NOT STARTED** (explicitly deferred in the in-flight docs) | — |
| Phase 5.1 — `/adlc-maintain` + maintenance cron | **NOT STARTED** | no `command/adlc-maintain.md` |
| Phase 5.2 — `prosecutor` meta-agent (7th agent) | **NOT STARTED** | `agent/` has 6 lens/verifier agents only |
| Phase 5.3 — publish `@adlc/opencode-package` to npm | **NOT STARTED** | package is `"private": true`; not on npm |
| Phase 5.4 — docs truth pass | **PARTIAL** | in-flight diff updates `docs/integrations/opencode.md`; ADR 0004 + `docs/opencode-integration-plan.md` untouched |

### Defects / friction found

1. **Install landmine (worst finding).** `lib/scaffold.mjs` registers `@adlc/opencode-package`
   in `opencode.json`'s `plugin` array — a name that does not exist on npm. OpenCode
   auto-installs npm plugin entries via Bun, so for anyone who didn't symlink from source
   the registered entry cannot resolve. Publishing (5.3) is the single highest-leverage
   install fix, and until it lands the scaffolder should register the local path it was
   actually loaded from, not the npm name.
2. **Version drift.** CI pins `opencode-ai@1.17.13`; upstream is at 1.17.17 (releases
   near-daily). The flush spec's planned version matrix (pinned + latest) was never wired.
3. **Stale upstream references.** `sst/opencode` moved to `anomalyco/opencode`; issue links
   (e.g. #7006 for dormant `permission.ask`) and docs need a sweep + re-verification.
4. **Falsified spec assumption.** Flush spec 4.1 assumed `session.prompt({outputFormat})`
   JSON-schema structured output. **No such field exists at 1.17.17.** The in-flight code
   already works around it (concatenated text parts); the spec text and ADR must record
   the correction. The real structured-output path is a registered verdict *tool* schema.
5. **Superseded plan doc still authoritative-looking.** `docs/opencode-integration-plan.md`
   describes machinery that never shipped (signed manifests, admin keys, `adlc-runner`
   extensions, pre-commit injection) and asserts in-session bash gating was "dropped" —
   contradicted by Phase 2. Mark it historical, pointing at ADR 0004 + the flush spec.

### New 1.17.17 surface worth absorbing (verified against package source)

- `plugin` config entries accept **`[name, options]` tuples** → per-repo structured plugin
  config, replacing env-var knobs.
- **`experimental.session.compacting`** (inject context into compaction) and
  **`experimental.compaction.autocontinue`** (suppress the synthetic continue turn) —
  direct context-rot defenses; today rails/ticket context can silently die at compaction.
- **`command.execute.before`** — intercept slash-command execution (lifecycle-order
  advisories, protect ADLC commands).
- `session.prompt` supports per-call **`system` override + `tools:{[name]:boolean}`
  enable/disable map** → locked-down, write-tool-free child sessions for gates.
- `shell.env` hook; `experimental.chat.system.transform` silent-discard bug (#17100) is
  fixed upstream, so the Phase 3 injection path is solid.
- Skills are discovered from `.claude/skills/` too (Claude-compatible) — dedup concern for
  repos with both integrations installed.
- No v2 plugin API yet; `PluginModule.tui?: never` confirms the TUI module surface is
  *reserved, not shipped* → keeping the TUI module deferred remains correct.

## Execution items (ordered by risk-reduction per effort)

### T-A — Land the in-flight Phase 4 (finish what was started) — FIRST
Apply the uncommitted diff from `.worktrees/opencode-native-flush` onto `opencode-integration`
(main-based; the 2 commits it lacks are docs-only, no conflicts), then: commit, run the full
gate battery (`/adlc-prosecute`, hollow-test, live-deny + live-tool proofs), PR.
Includes the already-written docs-truth updates. Retire the stale
`opencode-native-phase4` branch/worktree after transfer.
**AC:** 171+ tests green; `scripts/opencode-live-tool.mjs --require` passes in CI; docs no
longer claim the keyless bridge is unwired; old worktree removed.

### T-B — Installation: one-line, self-healing install
1. Un-private `@adlc/opencode-package`, fold into the lockstep `/release` (22nd package),
   publish. Scaffolder keeps registering the npm name — which now resolves and Bun
   auto-installs.
2. Until/unless loaded from npm, scaffolder registers the *resolved local path* instead of
   the unpublished npm name (detect via `import.meta.url`).
3. Single-command bootstrap: `npx @adlc/opencode-package init` (thin wrapper over the
   existing scaffold-cli) writes the `opencode.json` plugin entry + scaffolds `.adlc/` —
   install becomes: run one command, restart opencode.
4. Move env-var knobs (`ADLC_ALLOW_ADVISORY_HOOKS`, bypass flags that make sense per-repo)
   to the `[name, options]` plugin tuple; env vars remain as overrides.
5. Skills dedup: if `.claude/skills/adlc*` already exists (Claude Code integration
   present), skip or byte-match the opencode copy to avoid double skill listings.
**AC:** fresh repo + published package → working enforcement in ≤2 commands; smoke test
covers the npx path; docs Install section rewritten.

### T-C — Upstream sync & drift armor
1. Bump baseline: peer dep `>=1.17.13` verified against 1.17.17; CI live proofs run a
   **version matrix** — pinned floor (1.17.13) + `latest` (advisory job so upstream churn
   can't block unrelated merges, but drift is visible same-day).
2. `sst/opencode` → `anomalyco/opencode` reference sweep (docs, ADR, comments).
3. Re-verify `permission.ask` dormancy (#7006) at 1.17.17; if now dispatched, promote the
   dormant handler to a live-tested second lever.
**AC:** matrix job green on both versions; zero `sst/opencode` references; permission.ask
status re-recorded in ADR 0004 with a dated check.

### T-D — Native robustness: compaction survival + command gating
1. `experimental.session.compacting`: inject active ticket, scope, and frozen rails into
   the compaction context so enforcement context survives summarization.
2. `experimental.compaction.autocontinue`: when the build-gate says the session is
   degraded on a high-risk ticket, disable autocontinue (forces a human turn instead of
   the agent barreling on post-compaction).
3. `command.execute.before`: advisory lifecycle-order check (e.g. `/adlc-decompose`
   before an approved spec → warn) and tamper notice if ADLC command markdown was edited.
**AC:** unit tests with simulated compaction events; live proof extended to cover a
compaction cycle retaining rail context.

### T-E — Phase 4b: deterministic P5 runner (the leapfrog)
Native `adlc_prosecute` tool whose `execute()` drives fan-out → dedupe → verify →
loop-until-dry in first-party code using the tested `lib/prosecutor.mjs` helpers.
Child lens/verifier sessions use the 1.17.17-verified levers: per-call `system` override +
`tools` map (lens sessions get **no write tools**), verdicts returned through a registered
structured verdict tool (the correct replacement for the falsified `outputFormat`
assumption). `/adlc-prosecute` command becomes a thin invoker.
**AC:** prosecution of a seeded defect converges without model-driven orchestration;
lens sessions provably cannot write; live harness covers one full loop.

### T-F — Phase 5 parity ports
1. `/adlc-maintain` command + `docs/ci/adlc-maintenance.yml` weekly cron (CC parity).
2. `prosecutor` meta-agent (7th agent) wrapping the deterministic gates.
**AC:** command runs skill-rot + model-ratchet dry-run; cron template committed.

### T-G — Docs truth & historical hygiene (sweep, after T-A..T-F)
Mark `docs/opencode-integration-plan.md` historical/superseded; refresh ADR 0004
(answered questions → dated decisions, incl. the `outputFormat` correction and the
anomalyco move); final Status/Gaps pass on `docs/integrations/opencode.md`.
**AC:** no doc claims a capability without a runtime caller; plan doc carries a
superseded banner.

### Deferred (deliberately, re-validated today)
- **TUI plugin module** — `tui?: never` in `PluginModule` at 1.17.17: the surface is
  reserved upstream, not shipped. Revisit when the v2 plugin API lands.
- **`experimental_workspace.register` adapters** — watch; no ADLC use case yet.

## Sequencing & gates

T-A → T-B → T-C are independent after T-A lands (B/C can fan out). T-D and T-E depend on
T-C's baseline bump. T-F anytime after T-A. T-G last.
House rules per ticket: P1 spec-lint + premortem; trust-boundary tickets (T-A, T-C.3, T-D,
T-E touch enforcement) get adversarial design review at P1→P2; every merge gated by
`/adlc-prosecute` + adversarial-review (≥2 providers) at P5.
