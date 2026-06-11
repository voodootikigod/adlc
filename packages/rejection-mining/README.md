# rejection-mining

**ADLC Phase: C13** — org boundaries (the telco pattern, generalized)

Sister of `skill-mining`. Mines human PR review objections into *prosecution lenses* — structured rules for adversarial code review. Converts the recurring "nights of no" from institutional gatekeepers into automated pre-flight checks.

## What it does

1. Fetches PR review threads and comment bodies from the GitHub CLI (`gh`)
2. Filters for negative-signal language (objections, rejections, criticism)
3. Clusters similar objections using token-set Jaccard similarity (≥ 0.4)
4. Authors each cluster into a lens file: `<out-dir>/lens-<slug>.md`
5. Each lens includes a prosecution charter, checklist item, and anonymized example quotes

Result: "would security reject this?" is answered in seconds pre-submit instead of days post-queue.

## Usage

```
rejection-mining [--limit N] [--min N] [--out-dir PATH] [--write] [--llm] [--prompt-only] [--json]
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--limit N` | `50` | Maximum number of PRs to fetch |
| `--min N` | `2` | Minimum cluster size to author a lens |
| `--out-dir PATH` | `.aidlc/lenses` | Directory to write lens files into |
| `--write` | false | Emit lens files (default: dry-run) |
| `--llm` | false | Use LLM to sharpen lens title and charter (one `mid` call per cluster) |
| `--prompt-only` | false | Print LLM prompts and exit 0 (no API key required) |
| `--json` | false | Machine-readable JSON output |

## Examples

```bash
# Dry-run: show what would be mined (no files written)
rejection-mining

# Limit to recent 100 PRs, require 3+ matching comments to form a lens
rejection-mining --limit 100 --min 3

# Write lens files to default location
rejection-mining --write

# Write to custom directory with LLM-sharpened titles
rejection-mining --out-dir .aidlc/prosecution-lenses --write --llm

# Get the LLM prompts without calling any API
rejection-mining --prompt-only

# JSON output for orchestrators
rejection-mining --json
```

## Output

### Human-readable table

```
rejection-mining results
═══════════════════════
  PRs scanned:   47
  Signals found: 23
  Lenses:        3

  Title                           Signals  PRs    File
  ────────────────────────────────────────────────────────────────────────
  Error Exposure Leak             6        4      .aidlc/lenses/lens-error-expose-raw.md
  Hardcoded Credentials           5        3      .aidlc/lenses/lens-hardcode-credentials.md
  missing-null-check-accessing    4        2      .aidlc/lenses/lens-missing-null-check.md

  (dry-run — add --write to emit lens files)
```

### Lens file format

```markdown
# Lens: Error Exposure Leak

## Charter

When prosecuting a diff, specifically attempt to refute: raw error messages
or stack traces being passed directly to API response bodies or client UI.

## Checklist

- [ ] Does this diff trigger the pattern: *Error Exposure Leak*?

## Example Objections

> "don't expose the raw error message to the client here — it leaks internals" — A*** on PR #101

> "never expose raw error details to the API response body" — E*** on PR #102

---

*mined from 6 review comments across 4 PRs*
```

### JSON output shape

```json
{
  "totalPRs": 47,
  "skippedPRs": 0,
  "totalSignals": 23,
  "lensCount": 3,
  "lenses": [
    {
      "slug": "error-expose-raw",
      "title": "Error Exposure Leak",
      "count": 6,
      "prCount": 4,
      "path": ".aidlc/lenses/lens-error-expose-raw.md"
    }
  ]
}
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success — mining complete |
| 1 | Operational error — `gh` missing, auth failure, no PRs found |
| 2 | Gate fails (reserved; currently unused by this tool) |

## Requirements

- `gh` CLI must be installed and authenticated (`gh auth login`)
- Node.js ≥ 18

## ADLC relationship

- **Phase served:** C13 — institutionalizing "no"s before they become queue delays
- **Sister tools:** `skill-mining` (mines code patterns), `lesson-foundry` (mines prosecution findings)
- **Feeds into:** `adversarial-review` (prosecution lenses become review angles), `gate-manifest` (C11)

## Core gaps

None. All required functionality (LLM, CLI, exit codes) is available in `@aidlc/core`.

## Architecture

```
lib/
  gh.mjs       — gh CLI boundary (injectable for testing)
  signal.mjs   — negative-signal regex filter and body extraction
  cluster.mjs  — normalizeBody, jaccard, clusterSignals, deriveSlug
  mine.mjs     — fetchSignals, buildClusters (pipeline orchestration)
  lens.mjs     — renderLensFile, planLensEmissions (pure rendering)
  llm.mjs      — LLM prompt building and refinement
  report.mjs   — human table and JSON output
bin/
  rejection-mining.mjs  — thin CLI entry point
test/
  signal.test.mjs   — signal filter positive + negative fixtures
  cluster.test.mjs  — normalizeBody, jaccard, clustering
  lens.test.mjs     — lens file rendering
  mine.test.mjs     — full pipeline with fixture gh JSON (zero real gh calls)
```
