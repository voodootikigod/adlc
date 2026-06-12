# Package Reference

This reference is derived from `packages/*/README.md` and `packages/*/package.json`.
Follow each README for full options, output schemas, examples, and implementation notes.

## Packages

| Package | Binary | Role | Source |
| --- | --- | --- | --- |
| `@adlc/behavior-diff` | `behavior-diff` | Captures and compares HTTP/API behavior snapshots for the P6 human gate. | [`packages/behavior-diff/README.md`](../packages/behavior-diff/README.md) |
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
| `@adlc/rails-guard` | `rails-guard` | Enforces frozen rails, declared suppressions, and manifest recording. | [`packages/rails-guard/README.md`](../packages/rails-guard/README.md) |
| `@adlc/rejection-mining` | `rejection-mining` | Mines review rejections into reusable review lenses. | [`packages/rejection-mining/README.md`](../packages/rejection-mining/README.md) |
| `@adlc/review-calibration` | `review-calibration` | Measures reviewer recall by applying mutants and scoring whether review catches them. | [`packages/review-calibration/README.md`](../packages/review-calibration/README.md) |
| `@adlc/skill-rot` | `skill-rot` | Checks skill files for stale validation metadata and optional freshness stamping. | [`packages/skill-rot/README.md`](../packages/skill-rot/README.md) |
| `@adlc/spec-lint` | `spec-lint` | Gates specs for wishes, unverifiable acceptance criteria, and LLM-only verification. | [`packages/spec-lint/README.md`](../packages/spec-lint/README.md) |

## Command forms

```sh
behavior-diff capture --config behavior.json --out before.json
behavior-diff compare before.json after.json [--json]
coldstart <ticket-id> [options]
coldstart --all [options]
consensus-fix --test-cmd "..." --files a.mjs,b.mjs [options]
flail-detector <log-file> [--scope <glob>...] [--max-repeat <n>] [--max-bytes <n>] [--json]
gate-fuzzing [--suite <path>] [--n <int>] [--tier cheap|mid] [--json]
gate-manifest record <gate-name> [--ticket id] [--data '{json}'] [--files a,b,c] [--dir path] [--json]
gate-manifest verify [--json] [--dir path]
gate-manifest show [--ticket id] [--json] [--dir path]
gate-manifest attest [--ticket id] [--dir path]
hollow-test --test-cmd "node --test test/" [options]
lesson-foundry [options]
merge-forecast [options]
model-ratchet [--top <n>] [--review-cmd <cmd>] [--churn-limit <n>] [--dry-run] [--json]
model-router [--tickets <path>] [--floor <number>] [--json]
parallax --request "text"
parallax --file req.md
preflight [--test-cmd "..."] [--gh] [--llm] [--worktrees] [--json]
premortem <spec.md> [--tier cheap|mid|frontier] [--out report.md] [--json] [--prompt-only]
rails-guard [--base <ref>] [--ticket <id>] [--tickets <path>] [--rails <glob>...] [--record] [--json]
rejection-mining [--limit N] [--min N] [--out-dir PATH] [--write] [--llm] [--prompt-only] [--json]
review-calibration --review-cmd "cmd with {base} placeholder" [options]
skill-rot [path ...] [--write] [--json]
spec-lint <spec.md> [--llm] [--json] [--prompt-only]
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

Review evidence and calibration:

- `behavior-diff`
- `gate-manifest`
- `hollow-test`
- `review-calibration`
- `model-ratchet`
- `gate-fuzzing`

Compounding defenses:

- `lesson-foundry`
- `rejection-mining`
- `skill-rot`

Shared foundation:

- `@adlc/core`
