# flail-detector

Session-log flail analysis — mechanical two-strike rule. ADLC phase **C6 / P4 supervisor**.

Watches a build session log for flail signatures. On trigger: emits verdict
`flail`, prints a recommendation block, and exits 2 so CI can gate. Fully
deterministic; no LLM calls.

## Usage

```
flail-detector <log-file> [--scope <glob>...] [--max-repeat <n>] [--max-bytes <n>] [--json]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<log-file>` | Path to the session log file to analyze (required) |

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--scope <glob>` | _(none)_ | Declared-scope glob pattern (repeatable). When given, file paths found in tool-log lines that fall outside ALL supplied globs are flagged as **scope violations**. |
| `--max-repeat <n>` | `2` | Trigger the **repeated-error** signal when a normalized error signature appears >= n times. |
| `--max-bytes <n>` | _(no limit)_ | Trigger the **size** signal when the log file exceeds n bytes. |
| `--json` | off | Machine-readable JSON output for orchestrators. |
| `--help` | — | Print help and exit 0. |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Gate passes — no flail signals detected (clean) |
| `1` | Operational error — file not found, bad argument |
| `2` | Gate fails — one or more flail signals triggered |

## Signals

### 1. repeated-error

Lines matching `/error|exception|failed|cannot|ENOENT/i` are normalized
(lowercase; strip digits, hex literals, quoted strings, and absolute paths),
then counted per unique signature. Any signature occurring >= `--max-repeat`
times triggers this signal.

**Normalization** ensures that `Error: cannot find module "lodash" at line 42`
and `Error: cannot find module "express" at line 99` collapse to the same
signature — the error kind is what matters, not the varying operands.

### 2. scope-violation

Only active when `--scope` is given. File paths extracted from common
tool-log patterns:

- `Writing <path>`
- `Editing <path>`
- `Created <path>`
- `"file_path":"<path>"` (JSON tool-log format)

Any path that does not match at least one `--scope` glob is a violation.

### 3. edit-churn

The same file path appearing in >= 3 write/edit log lines (regardless of
which verb — Writing, Editing, or Created). Indicates the agent is cycling
back to the same file repeatedly.

### 4. size

When `--max-bytes` is given, triggers if the log file byte count exceeds the
threshold.

## Input Handling

If more than half the non-empty lines of the log parse as JSON objects, the
file is treated as **JSONL**: string values of the keys `content`, `text`, and
`message` are recursively extracted and fed into the signal detectors. All
other files are treated as **plain text**, one line at a time.

## Output

Human-readable (default):

```
flail-detector: FLAIL
  bytes: 361
  signals:
    repeated-error (1 signature(s)):
      [2x] error: cannot resolve module at line in
    scope-violation (1 path(s) outside scope):
      /etc/hosts
    edit-churn (1 file(s) edited >= 3 times):
      [3x] src/index.ts

  recommendation:
    Kill the session. Append these dead-ends to the ticket: error: cannot resolve module at line in
```

Machine-readable (`--json`):

```json
{
  "verdict": "flail",
  "signals": [...],
  "bytes": 361,
  "recommendation": "Kill the session. Append these dead-ends to the ticket: ..."
}
```

## Examples

```bash
# Analyze a plain-text session log
flail-detector session.log

# Enforce scope (write/edit must stay inside src/ or test/)
flail-detector session.log --scope 'src/**' --scope 'test/**'

# Raise the error-repeat threshold to 3
flail-detector session.log --max-repeat 3

# Flag oversized logs (e.g. > 1 MB context)
flail-detector session.log --max-bytes 1048576

# JSON for orchestrators
flail-detector session.log --json
```

## ADLC Phase

**C6 / P4 supervisor.** Encodes the two-strike regeneration rule mechanically.
See ADLC.md §C6 for the design rationale.

Intended to be invoked by a P4 supervisor after each build attempt. On `flail`
(exit 2): kill the session, append the dead-end signatures to the ticket, and
regenerate fresh. On second trigger: escalate to P2 — the ticket is wrong, not
the agent.

## Relationship to Sibling Tools

- **rails-guard (C5)**: enforces frozen rails on git diffs; flail-detector
  watches live session logs for behavioral drift.
- **consensus-fix (C7)**: fan-out fix strategy invoked after flail is
  confirmed; flail-detector is the upstream gate that triggers it.
- **premortem (C2)**: upstream risk analysis; flail-detector catches the
  risk materializing at runtime.

## Core Gaps

None. This tool uses only `parseArgs`, `opError`, `printJson`, `pass`,
`gateFail`, and `globMatch` from `@adlc/core`. No LLM, no git, no ledger
writes.
