# hollow-test

**ADLC phase: P3 gate (C4 — diff-scoped mutation)**

Diff-scoped mutation gate — the honest coverage check. Mutates only the lines
changed in your diff, runs your test suite against each mutant, and fails if
any mutation survives. A surviving mutant proves hollow coverage: lines are
executed but their behavior is unconstrained by any assertion.

Diff-scoping keeps the run at seconds-to-minutes rather than the hours that
kill whole-codebase mutation testing.

## Usage

```
hollow-test --test-cmd "node --test test/" [options]
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--test-cmd <cmd>` | *(required)* | Shell command to run the test suite. Must exit non-zero on failure. |
| `--base <ref>` | `HEAD` | Git base ref for the diff (e.g. `HEAD~1`, `main`, a SHA). |
| `--max <n>` | `20` | Maximum total mutants across all files. Budget is spread round-robin. |
| `--timeout-ms <n>` | `120000` | Per-mutant test-command timeout in milliseconds. |
| `--target <file>` | *(none)* | Mutate this file directly, independent of the diff (repeatable). Bypasses the test/spec path exclusion and mutates the whole file, not just diff-changed lines. |
| `--rails <ticket-file>` | *(none)* | Path to a ticket JSON file; its declared `rails` globs are expanded against `git ls-files` and added as mutation targets (repeatable). |
| `--json` | *(off)* | Machine-readable JSON output (for orchestrators). |
| `--help` | *(off)* | Show usage and exit 0. |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Gate passes — all mutants were killed. |
| `1` | Operational error — dirty working tree, not a git repo, bad arguments, or **nothing to mutate** (the diff contains no eligible source files and neither `--target` nor `--rails` was given). |
| `2` | Gate fails — one or more mutants survived (hollow coverage). |

### `--target` / `--rails`: the P3 rails-authoring / characterization-test case

A diff that adds **only test files** — exactly the shape of a P3 rails-authoring ticket, or
a characterization-test ticket that pins existing, unchanged (frozen-rail) behavior — has
nothing in `filterTargetFiles()`'s diff scope to mutate. Rather than silently reporting a
vacuous `0`/`0`/`0` pass (indistinguishable from a genuinely strong suite), `hollow-test`
exits `1` in that case unless an explicit target is given:

```bash
# Diff is test-only (new rails for src/foo.mjs, which itself didn't change) — mutate
# src/foo.mjs directly so the new rails are actually prosecuted:
hollow-test --test-cmd "node --test test/foo-rails.test.mjs" --base main \
  --target src/foo.mjs

# Same, but read the target from a ticket's declared "rails" (single-ticket object or a
# full tickets.json — rails merged across all tickets in the file):
hollow-test --test-cmd "node --test test/foo-rails.test.mjs" --base main \
  --rails .adlc/tickets.json
```

## Examples

```bash
# Check the last commit
hollow-test --test-cmd "node --test test/" --base HEAD~1

# Check staged changes vs main
hollow-test --test-cmd "npm test" --base main --max 30

# Machine-readable output for CI
hollow-test --test-cmd "node --test test/*.test.mjs" --json
```

## Safety guarantees

1. **Dirty-tree check**: refuses to run if `git status --porcelain` is non-empty.
   This prevents accidentally leaving a corrupted file if the process is
   interrupted. Commit or stash your changes first.

2. **File restoration**: every mutated file is restored via a `try/finally`
   block — even if the test command crashes or the process is interrupted via
   SIGINT. The SIGINT handler performs an emergency restore before exiting.

3. **Sequential execution**: mutants are applied and tested one at a time
   (never in parallel) to avoid concurrent writes to the same file.

## What is mutated (and what is skipped)

Files from the diff are **excluded** from mutation if their path contains `test`
or `spec`, or if they have extensions `.md`, `.json`, `.yml`, `.yaml`, `.lock`,
`.txt`, `.toml`, or `.snap`. `--target`/`--rails` files bypass this exclusion —
the caller is deliberately naming a mutation target.

Within diff-derived eligible files, only lines changed in the diff are
targeted; `--target`/`--rails` files are mutated in their entirety. Lines that
are blank, comments, imports, `export {`, or `console.*` calls are skipped.

### Mutation operators (from `@adlc/core`)

| Operator | Example |
|----------|---------|
| `invert-comparison` | `===` → `!==`, `<=` → `>` |
| `bool-flip` | `true` → `false` |
| `null-return` | `return expr` → `return null` |
| `off-by-one` | literal `n` → `n+1` |
| `logic-swap` | `&&` → `\|\|` |
| `negate-guard-subclause` | `Array.isArray(x)` ↔ `!Array.isArray(x)`; `if (value)` → `if (!value)`; loose `v == null` ↔ `v != null` |
| `array-literal-shrink` | `['id', 'title', 'scope']` → `['id', 'title']` |
| `ternary-swap` | `cond ? a : b` → `cond ? b : a` |

## JSON output schema

```json
{
  "tool": "hollow-test",
  "summary": {
    "total": 5,
    "killed": 4,
    "survived": 1
  },
  "mutants": [
    {
      "file": "src/calc.mjs",
      "line": 7,
      "operator": "null-return",
      "status": "survived",
      "timedOut": false,
      "original": "  return a + b;",
      "mutated": "  return null;"
    }
  ]
}
```

## Relationship to sibling tools

- **rails-guard (C5)**: enforces that test files are not modified during build
  (they are the measuring instrument). hollow-test verifies that those tests
  actually constrain behavior.
- **review-calibration (C8)**: uses the same `mutate` operators to plant bugs
  and measure reviewer recall. hollow-test and review-calibration share core
  mutation machinery.
- **flail-detector (C6)**: hollow-test is a P3 gate; flail-detector watches
  the P4 build session. They serve complementary phases.

## Core gaps

None. All required functionality (`gitDiff`, `isDirty`, `isGitRepo`, `git`,
`globMatch`, `mutate.generateMutants`, `mutate.applyMutant`,
`mutate.changedLinesFromDiff`, `parseArgs`, `pass`, `gateFail`, `opError`,
`printJson`) is available in `@adlc/core`.

## Implementation notes

### NODE_TEST_CONTEXT stripping

Node.js v22 sets `NODE_TEST_CONTEXT` in child process environments when
running under `node --test`. If a child process inherits this variable and
itself calls `node --test`, it silently skips all test files (exits 0).
hollow-test strips `NODE_TEST_CONTEXT` from the child environment before
running each mutant's test command. This ensures mutation trials work
correctly even when hollow-test is itself running inside a test harness.
