# @aidlc/review-calibration

**ADLC phase: P5 meta-gate — "who reviews the reviewer"**

Measures reviewer recall via planted bugs. Turns "we do adversarial review"
from a vibe into a number, exposes category-level blind spots, and re-runs on
every model change — catching the silent regressions everyone currently absorbs
unknowingly.

This is mutation testing aimed at the *reviewer* instead of the code (ADLC C8).

## How it works

1. **Target files**: Files changed in `--commit` (`git diff-tree`) filtered to
   non-test, non-config source code. Falls back to `--files` if the commit
   touches no eligible files.
2. **Plant selection**: `mutate.generateMutants` runs over each target file's
   full content (no line restriction). Up to `--plants` mutants are selected by
   round-robining across operators (off-by-one, bool-flip, invert-comparison,
   logic-swap, null-return) for category coverage.
3. **Apply all plants**: All selected mutants are written to the working tree
   simultaneously. The reviewer sees the planted diff vs the base commit.
4. **Run review command**: `--review-cmd` is executed with `{base}` replaced by
   the commit ref. The combined stdout+stderr is captured.
5. **Restore**: Files are always restored in a `finally` block. A SIGINT handler
   provides a second layer of protection.
6. **Score**: A plant is CAUGHT if the review output mentions its basename AND a
   line number within ±3, OR contains a ≥12-char substring of the mutated line.
   Recall = caught / total.
7. **Gate**: Exit 2 if recall < `--min-recall`; exit 0 otherwise.

## Safety

- **Refuses to run on a dirty working tree** (opError, exit 1). Commit or stash first.
- Files are **always restored** — `finally` block in the runner + SIGINT handler
  in the CLI.
- Exit codes from the review command: 0 and 2 are valid (pass / gate-fail).
  Any other exit code is treated as a crash (opError, exit 1).

## Usage

```
review-calibration --review-cmd "cmd with {base} placeholder" [options]
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--review-cmd <cmd>` | (required) | Shell command to run the reviewer. `{base}` is substituted with the commit ref. |
| `--commit <ref>` | `HEAD` | Commit whose changed files are used as plant targets. |
| `--plants <n>` | `8` | Number of bugs to plant. |
| `--min-recall <f>` | `0.5` | Minimum recall fraction required to pass (0–1). |
| `--files <list>` | — | Comma-separated fallback file list when commit has no eligible code files. |
| `--json` | false | Machine-readable JSON output. |
| `--help` | — | Show help. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Gate passes — recall ≥ `--min-recall` |
| `1` | Operational error — dirty tree, no plants generatable, review command crashed (exit ∉ {0,2}), or bad arguments |
| `2` | Gate fails — recall < `--min-recall` |

## Examples

**Basic calibration with adversarial-review:**
```bash
review-calibration \
  --review-cmd "adversarial-review --base {base} --json" \
  --commit HEAD \
  --plants 8 \
  --min-recall 0.6
```

**JSON output for orchestrators:**
```bash
review-calibration \
  --review-cmd "my-reviewer {base}" \
  --json
```

**Custom file fallback (when commit has no eligible source files):**
```bash
review-calibration \
  --review-cmd "my-reviewer {base}" \
  --commit HEAD \
  --files "src/auth.mjs,src/api.mjs"
```

**Testing with a trivial fake reviewer (CI smoke test):**
```bash
review-calibration \
  --review-cmd 'node -e "process.stdout.write(\"LGTM\\n\")"' \
  --min-recall 0 \
  --json
```

## JSON output shape

```json
{
  "recall": 0.625,
  "caught": 5,
  "total": 8,
  "falsePositives": 2,
  "minRecall": 0.5,
  "gatePass": true,
  "commit": "HEAD",
  "reviewExitCode": 0,
  "perOperator": {
    "off-by-one":        { "caught": 2, "total": 2, "recall": 1.0 },
    "bool-flip":         { "caught": 1, "total": 2, "recall": 0.5 },
    "invert-comparison": { "caught": 1, "total": 2, "recall": 0.5 },
    "logic-swap":        { "caught": 1, "total": 2, "recall": 0.5 }
  },
  "plants": [
    {
      "file": "src/auth.mjs",
      "line": 42,
      "operator": "invert-comparison",
      "status": "caught",
      "original": "  if (user.role === 'admin') {",
      "mutated":  "  if (user.role !== 'admin') {"
    }
  ]
}
```

`falsePositives` is informational — the count of `file:line`-style findings in
the review output that don't match any plant. Use to tune review verbosity.

## Scoring logic

**Caught** — a plant is caught if ANY of these is true:
1. The review output mentions the file's basename AND a line number within ±3 of
   the plant's line (e.g. `auth.mjs:42`).
2. The review output contains a ≥12-character contiguous substring of the
   mutated line (catches snippet-quoted findings regardless of line numbers).

**Per-operator recall** — the catch rate broken down by mutation operator.
Low recall on a specific operator reveals category-level blind spots
(e.g. low `logic-swap` recall → add a dedicated logic-flow review lens).

## Relationship to sibling tools

| Tool | Role |
|---|---|
| `hollow-test` (C4) | Mutation testing aimed at tests — kills mutants via the test suite |
| `review-calibration` (C8) | Mutation testing aimed at the reviewer — measures reviewer recall |
| `adversarial-review` | The reviewer under test; wire its output to `--review-cmd` |
| `gate-manifest` (C11) | Records the calibration score alongside each review verdict |

## Core gaps

None — all required functionality (`mutate.generateMutants`, `mutate.applyMutant`,
`isDirty`, `isGitRepo`, `git`, `parseArgs`, `pass`, `gateFail`, `opError`,
`printJson`) is available in `@aidlc/core`.
