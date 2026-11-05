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

Symlinked skill directories and symlinked `SKILL.md` files are followed, with cycle detection preventing infinite recursion on recursive symlink graphs. Directories named `node_modules` or `.git` below a search root are skipped. A symlink resolving into one is skipped during default discovery and is an operational error (exit 1) when you pass explicit paths; name the target path to check it.

## Flags

| Flag | Description |
|------|-------------|
| `--write` | When a skill has at least one `ok` claim and zero `stale` claims (`ok > 0 && stale === 0`), upsert `last-verified: <YYYY-MM-DD>` into the skill's frontmatter (created if absent). Skills with stale claims, zero claims, or only unverifiable claims are never stamped. |
| `--json` | Machine-readable output for orchestrators. Prints a JSON object with `skills[]` and `summary`. |

## What gets verified

For each `SKILL.md` file found recursively (skipping `node_modules` and `.git`):

1. **Commands** — the first word of something shaped like an invocation.
   A word in backticks is usually a name (an option, a tool, a model id, a
   file), not something to run, so most spans are not command claims.

   A word is **command-shaped** when it matches `^[a-z][a-z0-9_-]*$`: a
   dot (`SKILL.md`, `execute.before`, `gpt-4.1-mini`) or an uppercase
   letter (`advisoryHooks`, `PreToolUse`) means a name.

   - **Inline spans.** A span is a command claim only when its first word is
     command-shaped **and** one of these holds:
     - the word is a known **launcher**: `adlc`, `npx`, `npm`, `pnpm`,
       `yarn`, `bun`, `bunx`, `node`, `deno`, `git`, `gh`, `docker`, `make`,
       `python`, `python3`, `pip`, `cargo`, `go`, `curl`, `sh`, `bash`;
     - a later word is a flag (`-x`, `--x`), as in `mytool --version`;
     - the span starts with an explicit `$ ` prompt, as in `$ mytool`. Use
       this to make any span a claim.

     So `edit`, `typescript` or `adversarial-review` alone claim nothing,
     while `ls -la`, `npx adversarial-review` and `$ mytool` do.
   - **Fenced blocks.** Lines count only in a fence whose info string is
     empty or a shell language: `sh`, `bash`, `zsh`, `shell`, `console`,
     `shell-session`, `terminal`, `fish`, `ksh`. `ts`, `json`, `yaml`,
     `text` and other fences yield no claims; label a block `text` to keep
     it out. Inside a shell fence a line is a command claim when its first
     word is command-shaped, so a diagram line such as
     `Vague request? ──→ P0` is skipped.
   - **Linked spans.** A code span that is the whole text of a link to an
     absolute `http(s)` URL, as in ``[`docs/x.md`](https://…)``, is not a
     claim of any kind: the link says the file lives elsewhere.

   Verified via:
   - `./node_modules/.bin/<cmd>` presence, OR
   - `sh -c 'command -v <cmd>'`

   Placeholder tokens are skipped: `<ANGLE_BRACKETS>` and `UPPERCASE_VARS`
   (3+ chars, all caps/underscores/digits) are never counted as stale.

2. **File paths** — tokens containing `/` and a file extension (e.g.
   `src/index.mjs`), in inline spans and shell fences. Checked via
   `existsSync` from the repo root and from the skill's own directory.

3. **Script references** — `npm run X`, `pnpm X`, `yarn X` patterns.
   Key `X` is looked up in `scripts` of the root `package.json`. If no
   `package.json` exists, the claim is `unverifiable`. (`npx` is intentionally
   excluded — it runs registry packages rather than `package.json` scripts.)

**Claim statuses:**
- `ok` — verifiable and passes
- `stale` — verifiable but fails (counts toward gate failure)
- `unverifiable` — cannot determine truth (URLs, no `package.json`, ambiguous)

Unverifiable claims are never counted as stale. Skills with zero checkable claims are reported as `[NO-CLAIMS]` and are never stamped under `--write`. A skill whose claims are all unverifiable is reported as `[UNVERIFIED]`, is not counted clean, and is never stamped.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Gate passes — no skill has stale claims |
| `1` | Operational error — no `SKILL.md` files found, bad input, or an explicit path that cannot be fully inspected |
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
