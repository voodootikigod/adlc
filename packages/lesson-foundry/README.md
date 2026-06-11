# lesson-foundry

**ADLC Phase: P7 (compounding closer)**

Converts prosecution findings into permanent defenses. Every recurring finding is paid for exactly once.

> C9 in the ADLC component inventory. Without this tool the lifecycle does not get cheaper — lessons are re-bought on every run.

## What it does

1. Reads prosecution findings from a JSONL ledger (default: `.aidlc/findings.jsonl`)
2. Skips entries with `verdict === 'killed'`; surfaces malformed lines
3. Clusters findings by semantic similarity (token-set Jaccard >= 0.5)
4. Routes each cluster of size >= `--min` to its **cheapest permanent defense**:
   - **LINT** — any member desc contains a quoted literal or recognizable marker (TODO, FIXME, eslint-disable, etc.) → emits a grep-gate JSON descriptor + a runnable `check-<name>.mjs` script
   - **SKILL** — category is `convention`, `pattern`, `architecture`, or `style` → emits a `SKILL.md` stub with frontmatter and evidence quotes
   - **SPEC-GAP** — otherwise → appends a question to `interrogation-template.md` for P1 to address
5. By default: dry-run (prints what would be written). Add `--write` to emit files.
6. With `--gate`: exits 2 if any cluster has no existing defense file in `--out-dir`

## Usage

```
lesson-foundry [options]

Options:
  --ledger <name>    Ledger name to read findings from (default: findings)
  --min <n>          Minimum cluster size to surface (default: 2)
  --out-dir <path>   Output directory for defense files (default: .aidlc/lessons)
  --write            Emit files (default: dry-run — prints what WOULD be written)
  --gate             Exit 2 if any cluster >= --min has no defense file in --out-dir
  --llm              Refine cluster wording via one mid-tier LLM call per cluster
  --prompt-only      Print LLM prompts and exit 0 (works with zero API keys)
  --json             Machine-readable output (stdout JSON, errors to stderr)
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Gate passes — no recurring unbanked lessons (or --gate not set) |
| 1 | Operational error — bad input, unreadable ledger, write failure |
| 2 | Gate fails — one or more clusters have no defense file in --out-dir |

## Emitted file shapes

### LINT: `<name>.lint.json`

```json
{
  "name": "cluster-name",
  "pattern": "ESCAPED_LITERAL_OR_MARKER",
  "paths": ["**"],
  "message": "lesson-foundry: recurring finding — <desc>"
}
```

### LINT: `check-<name>.mjs`

A runnable Node.js script that greps the repo for the pattern and exits 2 on match, 0 when clean. Run it as a CI gate.

### SKILL: `<name>.SKILL.md`

Markdown with YAML frontmatter (`name`, `description`, `category`, `triggers`) and a body containing the rule, evidence quotes, and provenance count. Ready to load into any skill-mining pipeline.

### SPEC-GAP: `interrogation-template.md`

Appended-to file with checkbox questions for each spec-gap cluster. Answer these in the P1 spec to prevent recurring findings.

## Examples

**Dry-run to see what would be produced:**
```bash
lesson-foundry --ledger findings --min 2
```

**Write defense files:**
```bash
lesson-foundry --ledger findings --min 2 --write --out-dir .aidlc/lessons
```

**Gate in CI (fail if any recurring lesson is unbanked):**
```bash
lesson-foundry --ledger findings --min 2 --gate
```

**Machine-readable output:**
```bash
lesson-foundry --min 2 --gate --json
```

**Refine wording via LLM:**
```bash
lesson-foundry --min 2 --write --llm
```

**Print LLM prompts without calling any API:**
```bash
lesson-foundry --min 2 --prompt-only
```

## Relationship to sibling tools

| Tool | Relationship |
|------|-------------|
| `adversarial-review` | Primary source of findings — its JSONL output feeds the ledger lesson-foundry reads |
| `skill-mining` | lesson-foundry emits SKILL.md stubs; skill-mining manages the full skill registry |
| `spec-lint` | lesson-foundry appends to `interrogation-template.md`; spec-lint gates on spec quality |
| `rails-guard` | Defense files emitted by lesson-foundry should be PR'd like rails — read-only to other tools |

## ADLC phase

P7 — the compounding closer. Runs after prosecution findings accumulate across multiple ADLC cycles. The effect is a ratchet: each lesson is paid for exactly once, and recurring findings are demoted from probabilistic detection (LLM review, ~dollars per catch) to deterministic detection (lint/grep, ~free forever).

## Core gaps

None. All required functionality is available in `@aidlc/core`.
