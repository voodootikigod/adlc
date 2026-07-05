# Spec — spec-lint criterion parsing: bold pseudo-headings, wrapped list items, vacuous backticks (closes #71, #45)

**Phase:** P1 lightweight record for a bug-fix sweep in `packages/spec-lint`.

## Problem

`packages/spec-lint/lib/parse.mjs` and `lib/classify.mjs` produced both false negatives and false
positives depending on markdown formatting choices that carry no semantic difference to a reader:

1. **#71 (section detection):** `inCriteriaSection` only flipped on a literal `#{1,6}` heading, so a
   bold-only pseudo-heading like `**Acceptance criteria**:` was invisible — specs using that
   convention reported "no criteria found" entirely.
2. **#71 (wrapped list items):** `parseCriteria` walked `text.split('\n')` one physical line at a
   time, so a wrapped bullet's continuation line(s) never reached `classifyCriterion()`. A
   verification method sitting on the second physical line of a criterion was invisible, demoting a
   well-verified criterion to a WISH.
3. **#45 (vacuous backticks):** `classifyCriterion` treated *any* backtick span as sufficient proof
   of a verification method, so an unrelated code span (e.g. a bare filename like
   `` `vitest.config.ts` ``) falsely counted as VERIFIED, while a real command on a continuation line
   (fixed by #2) was previously invisible and falsely counted as a WISH.

## Fix

- `parse.mjs`: added `BOLD_HEADING_RE` (`/^\s*\*\*(.+?)\*\*:?\s*$/`) tested against the existing
  `CRITERIA_HEADING_RE` keyword set, scoped to lines that are *only* a bold label so inline bold text
  mid-sentence doesn't false-trigger section detection. Added `isContinuationLine()` and a
  lookahead loop in `parseCriteria()` that joins indented, non-blank, non-heading, non-list-marker
  continuation lines into the same logical criterion before it is pushed — matching how markdown
  renderers treat a single wrapped list item.
- `classify.mjs`: a bare backtick span no longer auto-verifies. `looksLikeVerificationCommand()`
  requires the span to contain a recognizable command word (`run`, `npm`, `assert`, `curl`, …), a CLI
  flag, a shell pipe/redirect, a function-call shape, or be introduced by phrasing like "Verified
  via"/"Run " immediately before the span. All other existing verification signals (`verify:`,
  `verified by`, `test:`, `exit code`, `assert`, `*.test.*`/`*.spec.*` paths) are unchanged.

## Acceptance criteria

- **AC1** — A bold-only pseudo-heading (e.g. `**Acceptance criteria**:`) is recognized as a criteria
  section, and inline bold text mid-sentence is not. *Verify:* `node --test packages/spec-lint/test/spec-lint.test.mjs` — `parseCriteria` describe block, bold-pseudo-heading cases, all green.
- **AC2** — A wrapped bullet's indented continuation line(s) are joined into the same logical
  criterion before classification, and consumption stops at the next list marker/blank
  line/heading. *Verify:* same test file — `parseCriteria` describe block, continuation-line cases.
- **AC3** — A criterion line containing only an unrelated backtick code span (e.g. a bare filename)
  classifies as WISH, not VERIFIED; a genuine command/assertion in backticks (optionally on a
  continuation line) still classifies as VERIFIED. *Verify:* same test file — `classifyCriterion`
  describe block (#45 cases) plus the `vacuous-filename.md` and `bold-heading-wrapped.md` fixture
  integration tests.

## Verification commands

```sh
node --test packages/spec-lint/test/spec-lint.test.mjs
node --test packages/cli/test/*.test.mjs   # regression check: CLI dispatch to spec-lint unaffected
```

Both commands must exit 0 with zero failures.
