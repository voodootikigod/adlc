# Package Reference

This reference is derived from `packages/*/README.md` and `packages/*/package.json`.
Follow each README for full options, output schemas, examples, and implementation notes.

## Packages

| Package | Binary | Role | Source |
| --- | --- | --- | --- |
| `@adlc/behavior-diff` | `behavior-diff` | Captures and compares HTTP/API behavior snapshots for the P6 human gate. | [`packages/behavior-diff/README.md`](../packages/behavior-diff/README.md) |
| `@adlc/cli` | `adlc` | Provides the stable dispatcher surface for all public ADLC tool execution. | [`packages/cli/README.md`](../packages/cli/README.md) |
| `@adlc/coldstart` | `coldstart` | Checks whether tickets are executable without agent guesswork. | [`packages/coldstart/README.md`](../packages/coldstart/README.md) |
| `@adlc/consensus-fix` | `consensus-fix` | Fans out candidate fixes and recommends, or optionally applies, the consensus winner that passes gates. | [`packages/consensus-fix/README.md`](../packages/consensus-fix/README.md) |
| `@adlc/core` | none | Shared LLM, git, CLI, ledger, ticket, and mutation primitives. | [`packages/core/README.md`](../packages/core/README.md) |
| `@adlc/flail-detector` | `flail-detector` | Detects repeated errors, scope violations, edit churn, and oversized session logs. | [`packages/flail-detector/README.md`](../packages/flail-detector/README.md) |
| `@adlc/gate-fuzzing` | `gate-fuzzing` | Runs hostile candidates against gate suites to find defeats and calibration gaps. | [`packages/gate-fuzzing/README.md`](../packages/gate-fuzzing/README.md) |
| `@adlc/gate-manifest` | `gate-manifest` | Records, verifies, shows, and attests append-only gate evidence. | [`packages/gate-manifest/README.md`](../packages/gate-manifest/README.md) |
| `@adlc/hollow-test` | `hollow-test` | Mutates changed code to find tests that pass without testing the intended behavior. | [`packages/hollow-test/README.md`](../packages/hollow-test/README.md) |
| `@adlc/lesson-foundry` | `lesson-foundry` | Mines repeated findings into deterministic defenses such as lint checks or skills. | [`packages/lesson-foundry/README.md`](../packages/lesson-foundry/README.md) |
| `@adlc/merge-forecast` | `merge-forecast` | Estimates fan-out width, dependency pressure, and merge backpressure. | [`packages/merge-forecast/README.md`](../packages/merge-forecast/README.md) |
| `@adlc/model-ratchet` | `model-ratchet` | Identifies hot files for re-prosecution after model or repository drift. | [`packages/model-ratchet/README.md`](../packages/model-ratchet/README.md) |
| `@adlc/model-router` | `model-router` | Assigns tickets to frontier, direct, or ladder model strategies. | [`packages/model-router/README.md`](../packages/model-router/README.md) |
| `@adlc/parallax` | `parallax` | Fans out readers to expose spec ambiguity, edge conflicts, or route conflicts. | [`packages/parallax/README.md`](../packages/parallax/README.md) |
| `@adlc/preflight` | `preflight` | Checks baseline environment readiness before fan-out. | [`packages/preflight/README.md`](../packages/preflight/README.md) |
| `@adlc/premortem` | `premortem` | Stress-tests an approved spec before implementation. | [`packages/premortem/README.md`](../packages/premortem/README.md) |
| `@adlc/prosecute` | `adlc-prosecute` | Records ticket- and revision-scoped P5 review evidence and asserts distinct reviewer-produced dry lenses. Invoke as `adlc prosecute` in normal workflows. | [`packages/prosecute/README.md`](../packages/prosecute/README.md) |
| `@adlc/rails-guard` | `rails-guard` | Enforces frozen rails, declared suppressions, and manifest recording. | [`packages/rails-guard/README.md`](../packages/rails-guard/README.md) |
| `@adlc/rejection-mining` | `rejection-mining` | Mines review rejections into reusable review lenses. | [`packages/rejection-mining/README.md`](../packages/rejection-mining/README.md) |
| `@adlc/review-calibration` | `review-calibration` | Measures reviewer recall by applying mutants and scoring whether review catches them. | [`packages/review-calibration/README.md`](../packages/review-calibration/README.md) |
| `@adlc/runner` | `adlc-runner` | Asserts phase completion from manifest artifacts rather than command success alone. Normal workflows reach it through `adlc run` and `adlc accept`. | [`packages/runner/README.md`](../packages/runner/README.md) |
| `@adlc/skill-rot` | `skill-rot` | Checks skill files for stale validation metadata and optional freshness stamping. | [`packages/skill-rot/README.md`](../packages/skill-rot/README.md) |
| `@adlc/spec-lint` | `spec-lint` | Gates specs for wishes, unverifiable acceptance criteria, and LLM-only verification. | [`packages/spec-lint/README.md`](../packages/spec-lint/README.md) |

## Command forms

```sh
adlc behavior-diff capture --config behavior.json --out before.json
adlc behavior-diff compare before.json after.json [--json]
adlc coldstart <ticket-id> [options]
adlc coldstart --all [options]
adlc consensus-fix --test-cmd "..." --files a.mjs,b.mjs [options]
adlc flail-detector <log-file> [--scope <glob>...] [--max-repeat <n>] [--max-bytes <n>] [--json]
adlc gate-fuzzing [--suite <path>] [--n <int>] [--tier cheap|mid] [--json]
adlc gate-manifest record <gate-name> [--ticket id] [--data '{json}'] [--files a,b,c] [--dir path] [--json]
adlc gate-manifest verify [--json] [--dir path]
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
adlc rejection-mining [--limit N] [--min N] [--out-dir PATH] [--write] [--llm] [--prompt-only] [--json]
adlc review-calibration --review-cmd "cmd with {base} placeholder" [options]
adlc run <p1|p2|p3|p4|p5|p6|p7> [--ticket id for p3-p6] [--revision rev for p5-p6] [--dir .adlc] [--json]
adlc accept --ticket id --packet .adlc/packet.json [--before .adlc/before.json] [--after .adlc/after.json] [--revision rev] [--dir .adlc] [--json]
adlc skill-rot [path ...] [--write] [--json]
adlc spec-lint <spec.md> [--llm] [--json] [--prompt-only]
```

## Package groups

Spec and ticket shaping:

- `parallax`
- `spec-lint`
- `premortem`
- `coldstart`

Execution supervision and rails:

- `preflight`
- `model-router`
- `merge-forecast`
- `rails-guard`
- `flail-detector`
- `consensus-fix`
- `runner`
  - public phase assertions are `adlc run` and `adlc accept`

Review evidence and calibration:

- `behavior-diff`
- `gate-manifest`
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
