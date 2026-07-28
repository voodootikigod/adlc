# Package Reference

This reference is derived from `packages/*/README.md` and `packages/*/package.json`.
Follow each README for full options, output schemas, examples, and implementation notes.

## Packages

| Package | Binary | Role | Source |
| --- | --- | --- | --- |
| `@adlc/behavior-diff` | `behavior-diff` | Captures and compares HTTP/API behavior snapshots for the P6 human gate. | [`docs/tools/behavior-diff.md`](./tools/behavior-diff.md) |
| `@adlc/build-gate` | `build-gate` | Denies starting a high-risk ticket's build in a degraded (context-rot) session unless an audited override is recorded. | [`packages/build-gate/README.md`](../packages/build-gate/README.md) |
| `@adlc/cli` | `adlc` | Provides the stable dispatcher surface for all public ADLC tool execution. | [`docs/tools/cli.md`](./tools/cli.md) |
| `@adlc/coldstart` | `coldstart` | Checks whether tickets are executable without agent guesswork. | [`docs/tools/coldstart.md`](./tools/coldstart.md) |
| `@adlc/consensus-fix` | `consensus-fix` | Fans out candidate fixes and recommends, or optionally applies, the consensus winner that passes gates. | [`docs/tools/consensus-fix.md`](./tools/consensus-fix.md) |
| `@adlc/copilot` | none (Copilot plugin) | Native ADLC plugin for the GitHub Copilot CLI (`plugins/adlc-copilot`): skills, `preToolUse` rails/build-gate hooks, allowlisted MCP gate tools, and read-only prosecution agents. Rail decision delegated to `@adlc/core`; the in-session hook **enforces headless** (deny-ask defaults to deny, overrides `--allow-tool`) unless `--allow-all-tools` is used, and CI `rails-guard-ci` is the unbypassable backstop. | [`docs/integrations/copilot.md`](./integrations/copilot.md) |
| `@adlc/core` | none | Shared LLM, git, CLI, ledger, ticket, and mutation primitives. | [`docs/tools/core.md`](./tools/core.md) |
| `@adlc/flail-detector` | `flail-detector` | Detects repeated errors, scope violations, edit churn, oversized session logs, and token spend past the ticket budget. | [`docs/tools/flail-detector.md`](./tools/flail-detector.md) |
| `@adlc/gate-fuzzing` | `gate-fuzzing` | Runs hostile candidates against gate suites to find defeats and calibration gaps. | [`docs/tools/gate-fuzzing.md`](./tools/gate-fuzzing.md) |
| `@adlc/gate-manifest` | `gate-manifest` | Records, verifies, shows, and attests append-only gate evidence. | [`docs/tools/gate-manifest.md`](./tools/gate-manifest.md) |
| `@adlc/gate-manifest` | `adlc-spend` | Aggregates recorded token usage into per-phase spend, the barbell shape, and the §6 diagnostics. Invoke as `adlc spend`. | [`docs/tools/spend.md`](./tools/spend.md) |
| `@adlc/hollow-test` | `hollow-test` | Mutates changed code to find tests that pass without testing the intended behavior. | [`docs/tools/hollow-test.md`](./tools/hollow-test.md) |
| `@adlc/lesson-foundry` | `lesson-foundry` | Mines repeated findings into deterministic defenses such as lint checks or skills. | [`docs/tools/lesson-foundry.md`](./tools/lesson-foundry.md) |
| `@adlc/merge-forecast` | `merge-forecast` | Estimates fan-out width, dependency pressure, and merge backpressure. | [`docs/tools/merge-forecast.md`](./tools/merge-forecast.md) |
| `@adlc/model-ratchet` | `model-ratchet` | Identifies hot files for re-prosecution after model or repository drift. | [`docs/tools/model-ratchet.md`](./tools/model-ratchet.md) |
| `@adlc/model-router` | `model-router` | Assigns tickets to frontier, direct, or ladder model strategies. | [`docs/tools/model-router.md`](./tools/model-router.md) |
| `@adlc/parallax` | `parallax` | Fans out readers to expose spec ambiguity, edge conflicts, or route conflicts. | [`docs/tools/parallax.md`](./tools/parallax.md) |
| `@adlc/preflight` | `preflight` | Checks baseline environment readiness before fan-out. | [`docs/tools/preflight.md`](./tools/preflight.md) |
| `@adlc/premortem` | `premortem` | Stress-tests an approved spec before implementation. | [`docs/tools/premortem.md`](./tools/premortem.md) |
| `@adlc/prosecute` | `adlc-prosecute` | Records ticket- and revision-scoped P5 review evidence and asserts distinct reviewer-produced dry lenses. Invoke as `adlc prosecute` in normal workflows. | [`docs/tools/prosecute.md`](./tools/prosecute.md) |
| `@adlc/rails-guard` | `rails-guard` | Enforces frozen rails, declared suppressions, and manifest recording. | [`docs/tools/rails-guard.md`](./tools/rails-guard.md) |
| `@adlc/rejection-mining` | `rejection-mining` | Mines review rejections into reusable review lenses. | [`docs/tools/rejection-mining.md`](./tools/rejection-mining.md) |
| `@adlc/review-calibration` | `review-calibration` | Measures reviewer recall by applying mutants and scoring whether review catches them. | [`docs/tools/review-calibration.md`](./tools/review-calibration.md) |
| `@adlc/runner` | `adlc-runner` | Asserts phase completion from manifest artifacts rather than command success alone. Normal workflows reach it through `adlc run` and `adlc accept`. | [`docs/tools/runner.md`](./tools/runner.md) |
| `@adlc/skill-rot` | `skill-rot` | Checks skill files for stale validation metadata and optional freshness stamping. | [`docs/tools/skill-rot.md`](./tools/skill-rot.md) |
| `@adlc/spec-lint` | `spec-lint` | Gates specs for wishes, unverifiable acceptance criteria, and LLM-only verification. | [`docs/tools/spec-lint.md`](./tools/spec-lint.md) |
| `@adlc/ticket-prune` | `ticket-prune` | Reports and tombstones (`completed: true` in place) stale, already-shipped tickets in `.adlc/tickets.json`. | [`docs/tools/ticket-prune.md`](./tools/ticket-prune.md) |

## Command forms

```sh
adlc behavior-diff capture --config behavior.json --out before.json
adlc behavior-diff compare before.json after.json [--json]
adlc coldstart <ticket-id> [options]
adlc coldstart --all [options]
adlc consensus-fix --test-cmd "..." --files a.mjs,b.mjs [options]
adlc flail-detector <log-file> [--scope <glob>...] [--max-repeat <n>] [--max-bytes <n>] [--spent-tokens <n>] [--budget <n>] [--json]
adlc gate-fuzzing [--suite <path>] [--n <int>] [--tier cheap|mid] [--json]
adlc gate-manifest record <gate-name> [--ticket id] [--data '{json}'] [--files a,b,c] [--dir path] [--json]
adlc gate-manifest verify [--json] [--dir path] [--allow-legacy-unsigned]
adlc gate-manifest show [--ticket id] [--json] [--dir path]
adlc gate-manifest attest [--ticket id] [--dir path]
adlc hollow-test --test-cmd "node --test test/" [options]
adlc lesson-foundry [options]
adlc merge-forecast [options]
adlc model-ratchet [--top <n>] [--review-cmd <cmd>] [--churn-limit <n>] [--dry-run] [--json]
adlc model-router [--tickets <path>] [--floor <number>] [--json]
adlc parallax --request "text"
adlc parallax --file req.md
adlc preflight [--test-cmd "..."] [--gh] [--llm] [--worktrees] [--json]
adlc premortem <spec.md> [--tier cheap|mid|frontier] [--out report.md] [--json] [--prompt-only]
adlc prosecute --input p5-passes.json --ticket id [--target label] [--revision rev] [--dir .adlc] [--json]
adlc rails-guard [--base <ref>] [--ticket <id>] [--tickets <path>] [--rails <glob>...] [--record] [--json]
adlc build-gate <ticket-id> [--depth <n>] [--session-bytes <n>] [--transcript <path>] [--depth-threshold <n>] [--bytes-threshold <n>] [--tickets <path>] [--reason <text>] [--json]
adlc rejection-mining [--limit N] [--min N] [--out-dir PATH] [--write] [--llm] [--prompt-only] [--json]
adlc review-calibration --review-cmd "cmd with {base} placeholder" [options]
adlc run <p1|p2|p3|p4|p5|p6|p7> [--ticket id for p3-p6] [--revision rev for p5-p6] [--dir .adlc] [--json]
adlc accept --ticket id --packet .adlc/packet.json [--before .adlc/before.json] [--after .adlc/after.json] [--revision rev] [--dir .adlc] [--json]
adlc skill-rot [path ...] [--write] [--json]
adlc spec-lint <spec.md> [--llm] [--json] [--prompt-only]
adlc spend [--ticket id] [--dir path] [--json]
adlc ticket-prune [--tickets path] [--base-ref ref] [--write] [--json]
```

## Package groups

Spec and ticket shaping:

- `parallax`
- `spec-lint`
- `premortem`
- `coldstart`
- `ticket-prune`

Execution supervision and rails:

- `preflight`
- `model-router`
- `merge-forecast`
- `rails-guard`
- `build-gate`
- `flail-detector`
- `consensus-fix`
- `runner`
  - public phase assertions are `adlc run` and `adlc accept`

Review evidence and calibration:

- `behavior-diff`
- `gate-manifest`
- `spend`
- `hollow-test`
- `prosecute`
- `review-calibration`
- `model-ratchet`
- `gate-fuzzing`

Compounding defenses:

- `lesson-foundry`
- `rejection-mining`
- `skill-rot`

Shared foundation:

- `@adlc/core`
- `@adlc/cli`

Harness plugins (native integrations under `plugins/`, not `packages/` — they
wire the gate toolkit into a specific agentic harness and delegate all rail /
ticket / prosecution logic to `@adlc/core`):

- `@adlc/copilot` — GitHub Copilot CLI (see [`docs/integrations/copilot.md`](./integrations/copilot.md))
