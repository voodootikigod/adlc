# @adlc/consensus-fix

N-version programming for failing tests. Fan N independent LLM completions at the same broken test, evaluate each candidate, group survivors by agreement, and recommend the smallest fix from the largest consensus group.

**ADLC phase served: C7 / P4** — hard bugs that single-shot fixes can't crack, exploiting sampling diversity (E1).

---

## Usage

```
consensus-fix --test-cmd "..." --files a.mjs,b.mjs [options]
```

### Required flags

| Flag | Description |
|------|-------------|
| `--test-cmd <cmd>` | Shell command to run the failing test. Must exit non-zero when the bug is present. |
| `--files <paths>` | Comma-separated list of source files the LLM is allowed to modify. |

### Optional flags

| Flag | Default | Description |
|------|---------|-------------|
| `--rails <cmd>` | _(none)_ | The **regression gate**: a command that runs the FULL frozen rail suite (all tests + types). A candidate survives only if BOTH `--test-cmd` and `--rails` exit 0. A candidate that fixes the repro but reddens the rails is **rejected**, not ranked. If omitted, candidates are checked only against `--test-cmd` and a **WARNING** is printed (no silent caps). |
| `--n <int>` | `3` | Number of independent fix candidates to generate. |
| `--tier cheap\|mid\|frontier` | `mid` | LLM tier to use for completions. |
| `--apply` | off | Write the winning fix. Default is dry-run (report only). |
| `--allow-dirty` | off | Skip dirty-tree check. Useful in CI with staged-only changes. |
| `--json` | off | Machine-readable output (JSON to stdout). |
| `--prompt-only` | off | Print the prompt(s) that would be sent and exit 0. Works with zero API keys. |

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Gate passes: at least one candidate survived and there is a consensus group with 2+ members (or `--n < 3`). |
| `1` | Operational error: bad arguments, unreadable files, dirty tree (without `--allow-dirty`), no LLM provider. |
| `2` | Gate fails: no candidates survived OR all survivors are singletons and `--n >= 3` (all-divergent, spec ambiguity). |

---

## How it works

1. **Pre-flight**: run `--test-cmd` once. If it exits 0, the test already passes — `opError`.
2. **Snapshot**: capture the full content of every `--files` path.
3. **Fan**: send N independent, stateless LLM completions in parallel with the prompt: failing command + last 4000 chars of test output + all source file contents. Request JSON `{changes: [{file, content}]}`.
4. **Evaluate sequentially**: for each candidate:
   - Parse and validate JSON. Discard if invalid or if any `file` is not in `--files`.
   - Apply changes, run `--test-cmd` (the **repro gate**). If it passes and `--rails` was supplied, run `--rails` (the **regression gate**) against the same applied changes. A candidate survives only if BOTH exit 0. A candidate that passes the repro but reddens the rails is rejected (lands in `failed`, not `survivors`).
   - Record pass/fail and changed-line count.
   - Restore snapshot (`finally`) regardless of outcome.
5. **Agreement grouping**: normalize each surviving changeset (collapse whitespace per line) and group identical sets.
6. **Winner selection**: among candidates that passed BOTH gates, pick the member of the largest agreement group with the fewest changed lines (ties broken by candidate index). The smallest-diff tiebreaker never sees a candidate that failed the rails, so it cannot reward a gaming fix.
7. **Output**: dry-run report by default; `--apply` writes the winner.

### All-divergent detection

When `--n >= 3` and every survivor is in its own singleton group, the tool exits 2 with the message `all-divergent: spec ambiguity — escalate`. This is a signal that the test specification is ambiguous about something load-bearing — divergence is evidence, not noise.

---

## Examples

```bash
# Dry-run: see what the winning fix would be without writing it
consensus-fix --test-cmd "node --test test/math.test.mjs" \
              --files src/math.mjs \
              --n 5

# Repro gate + full rails regression gate (recommended).
# A candidate that fixes the one test but breaks any other test is rejected.
consensus-fix --test-cmd "node --test test/math.test.mjs" \
              --rails    "node --test test/*.test.mjs" \
              --files src/math.mjs \
              --n 5

# Apply the winner
consensus-fix --test-cmd "npm test -- --grep 'add function'" \
              --rails    "npm test" \
              --files src/add.mjs,src/utils.mjs \
              --apply

# Preview prompts without any API key
consensus-fix --test-cmd "cargo test test_parse" \
              --files src/parser.mjs \
              --n 3 \
              --prompt-only

# Machine-readable output for orchestrators
consensus-fix --test-cmd "pytest tests/test_core.py::test_sum" \
              --files lib/core.mjs \
              --json

# Allow running against an uncommitted working tree
consensus-fix --test-cmd "node --test test/*.test.mjs" \
              --files lib/broken.mjs \
              --allow-dirty --n 3
```

---

## JSON output shape (`--json`)

```json
{
  "summary": {
    "total": 3,
    "passed": 2,
    "failed": 1,
    "discarded": 0,
    "groups": 1,
    "allDivergent": false,
    "railsChecked": true
  },
  "groups": [
    { "groupIndex": 0, "size": 2, "candidateIndices": [0, 2] }
  ],
  "winner": {
    "index": 0,
    "changedLines": 1,
    "largestGroupSize": 2,
    "changes": [{ "file": "src/math.mjs", "content": "..." }],
    "applied": false
  },
  "discardedDetails": []
}
```

---

## Safety guarantees

- **Dirty-tree guard**: refuses to run against a dirty git tree unless `--allow-dirty`. Prevents accidental loss of unstaged work.
- **Snapshot + restore in `finally`**: every candidate evaluation restores all `--files` to their original content, even if the test crashes or the LLM returns garbage.
- **SIGINT restore**: if interrupted (Ctrl-C), the snapshot is restored before exit.
- **File-list enforcement**: any candidate that references a file outside `--files` is discarded with a diagnostic message, never written.

---

## LLM provider detection

Inherits from `@adlc/core`. Checks (in order): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`. Force a provider with `ADLC_PROVIDER`. Override the model per tier via `ADLC_MODEL_CHEAP`, `ADLC_MODEL_MID`, `ADLC_MODEL_FRONTIER`.

---

## Relationship to sibling tools

- **flail-detector (C6)**: detects when a single agent is spinning. `consensus-fix` is the escalation path — run it when flail-detector fires on a hard bug.
- **premortem (C2)**: identifies failure modes before building. `consensus-fix` fixes failure modes discovered during test runs.
- **rails-guard (C5)**: enforces read-only rails. `consensus-fix` respects the `--files` list as its own rails boundary.
- **hollow-test (C4)**: finds tests that don't actually test anything. A test that `consensus-fix` keeps failing on might be hollow — run `hollow-test` to check.

---

## Core gaps

None. `fan`, `complete`, `extractJson`, `detectProvider`, `resolveModel`, `parseArgs`, `pass`, `gateFail`, `opError`, `printJson`, `promptOnly`, and `isDirty` are all provided by `@adlc/core`.
