# skill-rot

**ADLC phase: P7 — cache invalidation (C10)**

Skills are caches. `skill-rot` validates that the verifiable claims inside each
`SKILL.md` file still hold against the current repository. Stale skills deliver
misinformation with the authority of a cached expert — worse than no skill at
all. Run weekly in CI to keep the skill corpus honest.

## Usage

```
skill-rot [path ...] [--write] [--json]
```

Default search roots (searched only when they exist):
- `.claude/skills`
- `.agents/skills`
- `skills`

Pass one or more explicit path arguments to override the defaults.

## Flags

| Flag | Description |
|------|-------------|
| `--write` | When **all** claims in a skill are ok, upsert `last-verified: <YYYY-MM-DD>` into the skill's frontmatter (created if absent). Skills with stale claims are never stamped. |
| `--json` | Machine-readable output for orchestrators. Prints a JSON object with `skills[]` and `summary`. |

## What gets verified

For each `SKILL.md` file found recursively (skipping `node_modules` and `.git`):

1. **Commands** — backtick-enclosed spans and fenced code block lines whose
   first token looks like a command name. Verified via:
   - `./node_modules/.bin/<cmd>` presence, OR
   - `sh -c 'command -v <cmd>'`

   Placeholder tokens are skipped: `<ANGLE_BRACKETS>` and `UPPERCASE_VARS`
   (3+ chars, all caps/underscores/digits) are never counted as stale.

2. **File paths** — tokens containing `/` and a file extension (e.g.
   `src/index.mjs`). Checked via `existsSync` from the repo root and from the
   skill's own directory.

3. **Script references** — `npm run X`, `npx X`, `pnpm X`, `yarn X` patterns.
   Key `X` is looked up in `scripts` of the root `package.json`. If no
   `package.json` exists, the claim is `unverifiable`.

**Claim statuses:**
- `ok` — verifiable and passes
- `stale` — verifiable but fails (counts toward gate failure)
- `unverifiable` — cannot determine truth (URLs, no `package.json`, ambiguous)

Unverifiable claims are never counted as stale.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Gate passes — all skills clean |
| `1` | Operational error — no `SKILL.md` files found, bad input |
| `2` | Gate fails — at least one skill has stale claims |

## Examples

```bash
# Check defaults (.claude/skills, .agents/skills, skills)
skill-rot

# Check specific directories
skill-rot .claude/skills .agents/skills

# Stamp clean skills with today's date
skill-rot --write

# JSON output for CI integrations
skill-rot --json
```

## Relationship to sibling tools

- **lesson-foundry (C9)** — produces skills; `skill-rot` validates they stay fresh
- **review-calibration (C8)** — calibrates review quality; `skill-rot` prevents outdated guidance corrupting that calibration loop
- **gate-manifest (C11)** — can consume `skill-rot` exit code as a provenance signal

## Core gaps

None. This tool uses only Node 18+ built-ins and `@adlc/core` for CLI
utilities (`parseArgs`, `pass`, `gateFail`, `opError`, `printJson`).
