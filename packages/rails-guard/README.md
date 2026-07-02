# rails-guard

Rail-freeze enforcement and suppression-marker gate (ADLC C5).

Blocks builder edits to declared frozen rail paths during P4, and greps added
diff lines for suppression markers that escape test/lint coverage. On a clean
pass it can record a **rails-diff-empty proof** in the gate manifest.

## ADLC Phase

**C5 — P3/P4 enforcement.** Sits in the CI gate between P3 (charter /
planning) and P4 (builder execution). Guards two invariants simultaneously:

1. **Rail-freeze**: declared rail paths (test files, contract types, CI config)
   must not be touched by the builder during P4.
2. **Suppression-marker gate**: newly added `.skip(`, `.only(`, `xfail`,
   `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `# noqa`, `#[ignore]`
   lines are blocked unless the active ticket's `body` contains an explicit
   `allow-suppression: <marker>` declaration. **Prose documentation files**
   (`.md`, `.markdown`) are exempt from this scan — a marker in prose is never an
   executed suppression, and docs (including this README) legitimately name the
   markers when describing the rule. `.mdx` is **not** exempt: it compiles to
   JSX/TS and can carry operative suppressions, so it is scanned like code.

## Usage

```
rails-guard [--base <ref>] [--ticket <id>] [--tickets <path>] \
            [--rails <glob>...] [--record] [--json]
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--base <ref>` | `HEAD` | Git ref to diff against |
| `--ticket <id>` | — | Load rails and `allow-suppression` declarations from this ticket |
| `--tickets <path>` | `.adlc/tickets.json` | Path to tickets file |
| `--rails <glob>` | — | One or more frozen-path globs (repeatable; overrides `ticket.rails`) |
| `--record` | off | On a clean pass, append a manifest entry to `.adlc/manifest.jsonl` |
| `--json` | off | Emit machine-readable JSON result |
| `--help` | — | Print this help and exit 0 |

### Rail source resolution

1. If `--rails` globs are supplied they are used directly.
2. Otherwise `--ticket` must be provided; rails come from `ticket.rails`.
3. If neither is available the tool exits 1 (operational error).

### allow-suppression declarations

To permit a specific suppression marker, add this exact text to the ticket body:

```
allow-suppression: @ts-ignore
allow-suppression: .skip(
```

One declaration per line; case-sensitive; marker text must match exactly.

## Examples

```bash
# Check that no frozen test files were touched, fail on any suppression
rails-guard --rails "test/**" --rails "schema/**"

# Use rails declared in ticket T42; allow .skip( for known broken test
rails-guard --ticket T42 --tickets .adlc/tickets.json

# Diff against a feature branch base commit
rails-guard --rails "test/**" --base origin/main

# CI gate with machine-readable output + manifest record on clean pass
rails-guard --rails "test/**" --json --record
```

## Output

### Human-readable (default)

Clean:
```
rails-guard: all checks passed
```

Violations:
```
rails-guard: 2 violation(s) found
  [rail-edit]   test/auth.test.ts  (matched globs: test/**)
  [suppression] src/foo.ts:12  marker: @ts-ignore
                  // @ts-ignore
```

### JSON (`--json`)

```json
{
  "tool": "rails-guard",
  "base": "HEAD",
  "ticket": "T42",
  "railGlobs": ["test/**"],
  "railGlobError": null,
  "railsDiffEmpty": true,
  "suppressionsClean": false,
  "passed": false,
  "violations": [
    {
      "file": "src/foo.ts",
      "type": "suppression",
      "marker": "@ts-ignore",
      "lineNo": 12,
      "line": "// @ts-ignore"
    }
  ]
}
```

### Manifest record (`--record`, clean pass only)

Appended to `.adlc/manifest.jsonl`:

```json
{
  "ts": "2026-06-10T12:00:00.000Z",
  "type": "rails-check",
  "ticket": "T42",
  "base": "HEAD",
  "railsDiffEmpty": true,
  "suppressionsClean": true,
  "railFiles": {
    "test/auth.test.ts": "abc123...",
    "schema/types.ts": "def456..."
  }
}
```

`railFiles` contains the SHA-256 of every repo file that matches a rail glob at
the time of the clean pass — a content-addressed snapshot usable for auditing.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Gate passes — no violations |
| `1` | Operational error — not a git repo, bad input, no rails resolvable |
| `2` | Gate fails — violations found (list printed to stderr / JSON) |

## Violation types

| `type` | Meaning |
|--------|---------|
| `rail-edit` | A changed file matches a frozen rail glob |
| `suppression` | An added line contains a suppression marker not declared in the ticket |

## Sibling tools

- **flail-detector (C6)**: uses `--record` manifest entries to verify no
  builder session slipped past the gate.
- **consensus-fix (C7)**: runs every candidate fix through `rails-guard` before
  accepting it as a survivor.
- **merge-forecast**: reads `manifest.jsonl` to surface gate history alongside
  merge risk.

## Core gaps

None. All required APIs (`globMatch`, `hashFiles`, `appendEntry`, `changedFiles`,
`gitDiff`, `loadTickets`) are present in `@adlc/core`.
