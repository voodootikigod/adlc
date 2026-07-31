// Suppression-marker detection in git diffs.
// A "suppression marker" is a test/lint escape hatch that weakens coverage.
// Markers are allowed only when the ticket body explicitly declares them.

/** All suppression patterns to detect. */
export const SUPPRESSION_MARKERS = [
  '.skip(',
  '.only(',
  'xfail',
  '@ts-ignore',
  '@ts-expect-error',
  'eslint-disable',
  '# noqa',
  '#[ignore]',
];

/**
 * Parse added lines from a unified diff string.
 * Returns [ { file, lineNo, content } ] for each added line.
 * Lines starting with '+++' (diff header) are excluded.
 *
 * The `+++ b/path` file-header check is recognized ONLY OUTSIDE a hunk (`inHunk`
 * false). An added source line that itself starts with `++ ` (a pre-increment
 * expression with a space, e.g. `++ counter;` — unusual but valid JS) becomes
 * `+++ counter;` once diff-prefixed with its own leading `+`; without this guard that
 * line is misread as the START OF A NEW FILE's header, resetting `currentFile` to the
 * bogus name `counter;` and silently misattributing every added line after it — a
 * verified bypass for any consumer of this function that gates on which FILE an added
 * line belongs to (this module's own suppression scanner included).
 *
 * Hunk state resets on the unambiguous `diff --git ` marker — never on `--- `, since a
 * removed line starting with `-- ` becomes `--- text` once diff-prefixed, the
 * identical ambiguity on the old-file-header side — AND once a hunk's declared
 * old/new line counts (from its `@@ -a,b +c,d @@` header) are fully consumed. The
 * latter matters for a concatenated multi-file patch with no `diff --git` separator
 * between files (only consecutive `--- a/x`/`+++ b/x` header pairs): without it, the
 * parser stays "in" the first file's hunk forever, reads the next file's `+++ b/y`
 * line as hunk BODY content (an added line, since it starts with `+`), and never
 * recognizes the second header — misattributing every line after it to the first file.
 */
export function parseAddedLines(diffText) {
  const lines = diffText.split('\n');
  const results = [];
  let currentFile = null;
  // Never read before the `@@` branch below sets them, and that branch always sets
  // `inHunk = true` in the same step — so no initial value here is ever observed;
  // left uninitialized (undefined, falsy) rather than given a literal that a
  // mutation test could flip without changing behavior.
  let newLineNo;
  let inHunk;
  let oldRemaining;
  let newRemaining;

  for (const raw of lines) {
    // Unambiguous start of the next file's diff section — never produced by
    // diff-prefixing a content line, so safe to use for resetting hunk state. Load
    // -bearing independently of the count-based closing check below: a hunk header
    // that OVER-declares its line count (lies about how many lines follow) never
    // reaches the exact-zero close on its own, so without this hard reset the next
    // file's `+++` header would be missed and its added lines misattributed to the
    // previous file (see the "lying hunk header" test).
    if (raw.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }

    // A hunk's declared body has been fully consumed — the following line is a new
    // header, not more hunk content, even with no `diff --git` in between. Strict
    // equality (not <=): both counters only ever reach exactly 0 while inHunk is
    // being actively decremented, never negative, since this check itself stops
    // further decrementing the moment they do.
    if (inHunk && oldRemaining === 0 && newRemaining === 0) inHunk = false;

    // New file header: +++ b/path/to/file — recognized only outside a hunk.
    if (!inHunk && raw.startsWith('+++ ')) {
      const fileMatch = raw.match(/^\+\+\+ (?:b\/)?(.+)$/);
      currentFile = fileMatch ? fileMatch[1] : null;
      newLineNo = 0;
      continue;
    }

    // Hunk header: @@ -a,b +c,d @@ (b and d default to 1 when omitted).
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        oldRemaining = m[1] !== undefined ? parseInt(m[1], 10) : 1;
        newLineNo = parseInt(m[2], 10) - 1;
        newRemaining = m[3] !== undefined ? parseInt(m[3], 10) : 1;
      }
      inHunk = true;
      continue;
    }

    if (!inHunk) continue; // a header line (---/+++), or text between diff sections

    // Context line
    if (raw.startsWith(' ')) {
      newLineNo++;
      oldRemaining--;
      newRemaining--;
      continue;
    }

    // Removed line — does not count in new side. Also matches the old-file `--- a/path`
    // header when outside a hunk, which needs no special handling here: it never
    // touches currentFile/newLineNo either way.
    if (raw.startsWith('-')) {
      oldRemaining--;
      continue;
    }

    // Added line
    if (raw.startsWith('+')) {
      newLineNo++;
      newRemaining--;
      if (currentFile !== null) {
        results.push({ file: currentFile, lineNo: newLineNo, content: raw.slice(1) });
      }
      continue;
    }
  }

  return results;
}

// CommonMark fenced-code detection lives in @adlc/core now — shared with spec-lint
// and any other text-scanning gate (see docs/review-lenses/text-scanning-gates.md).
// Re-exported here so this module's importers (bin, tests) keep their import site.
export { computeFencedLines } from '@adlc/core';

/**
 * Documentation file extensions (lowercase, leading dot). Suppression markers are
 * code constructs; prose documentation legitimately names them (an integration
 * guide, this package's own README). A marker in a prose doc is never an executed
 * suppression, so scanning docs only yields false positives with no coverage gain.
 *
 * Only NON-EXECUTABLE prose markdown is exempt. `.mdx` is deliberately EXCLUDED: it
 * compiles to JSX/TS and can carry real, operative type- and lint-ignore
 * suppressions, so it is scanned like any other code file. Kept intentionally minimal
 * — every exempt extension is bypass surface for a security gate (both this list's
 * scope and the `.mdx` exclusion were tightened by cross-model adversarial review).
 */
export const DOC_EXTENSIONS = ['.md', '.markdown'];

/**
 * True when `file`'s FINAL extension is a documentation format (case-insensitive).
 * Only the true trailing suffix counts, so a code file like `render.md.mjs` (ext
 * `.mjs`) is still scanned — the check must not be fooled by `.md` appearing
 * mid-name. Returns false for a non-string, empty path, dotfile, or no-extension file.
 */
export function isDocFile(file) {
  if (typeof file !== 'string' || file === '') return false;
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false; // no extension, or a leading-dot name like ".md"
  return DOC_EXTENSIONS.includes(base.slice(dot).toLowerCase());
}

/**
 * True when `file`'s final extension is `.mdx`. MDX is scanned like code (it
 * compiles to JSX/TS), but its Markdown code CONTEXTS — inline spans and fenced
 * blocks — render as literal text and cannot carry an operative suppression, so
 * markers there are prose, not escape hatches. Uses the same true-suffix logic as
 * isDocFile so a code file like `x.mdx.ts` is not treated as MDX.
 */
export function isMdxFile(file) {
  if (typeof file !== 'string' || file === '') return false;
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return base.slice(dot).toLowerCase() === '.mdx';
}

/**
 * Remove Markdown inline-code spans (`` `…` ``) from a line so their contents are
 * not matched as suppressions. Backticks are paired left-to-right; an unmatched
 * trailing backtick leaves the rest of the line intact (scanned).
 *
 * A backtick region that contains a `${` interpolation is a JS/JSX template literal
 * whose interpolated expression is OPERATIVE code (a test-focus call inside the
 * interpolation actually runs), NOT an inert Markdown code span — it is preserved
 * verbatim so its markers are still scanned. This fails closed: a genuine prose span
 * that happens to contain a literal `${` is scanned too (a false positive), never
 * silently skipped.
 */
export function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, (span) => (span.includes('${') ? span : ''));
}

/**
 * Find suppression markers in added lines.
 * Returns [ { file, lineNo, marker, content } ].
 *
 * Skips:
 *   - prose docs (isDocFile: `.md`/`.markdown`) — never executed code;
 *   - `.mdx` lines inside a fenced code block — inert display text;
 *   - marker occurrences inside `.mdx` inline-code spans — inert display text.
 * A marker in the MDX ESM/JSX layer (outside spans and fences) is still scanned,
 * so real, operative type/lint suppressions in MDX remain caught.
 *
 * @param {Array} addedLines  [ { file, lineNo, content } ]
 * @param {object} [opts]
 * @param {(file: string, lineNo: number) => boolean} [opts.isFenced]
 *        Authoritative "is this `.mdx` line inside a fenced code block?" predicate,
 *        computed from full file content by the caller. Defaults to always-false,
 *        which FAILS CLOSED: an `.mdx` fenced marker the caller could not classify
 *        is scanned (a false positive), never silently skipped.
 */
export function findSuppressions(addedLines, { isFenced = () => false } = {}) {
  const found = [];
  for (const { file, lineNo, content } of addedLines) {
    if (isDocFile(file)) continue;

    let scanText = content;
    if (isMdxFile(file)) {
      if (isFenced(file, lineNo)) continue; // inside a fenced code block — inert prose
      scanText = stripInlineCode(content); // strip inline-code spans — inert prose
    }

    for (const marker of SUPPRESSION_MARKERS) {
      if (scanText.includes(marker)) {
        found.push({ file, lineNo, marker, content });
        break; // one violation per line is enough
      }
    }
  }
  return found;
}

/**
 * Determine whether a suppression marker is allowed by the ticket body.
 * The ticket body must contain `allow-suppression: <marker>` (exact match,
 * case-sensitive) to permit the marker.
 *
 * @param {string} marker
 * @param {string} ticketBody
 * @returns {boolean}
 */
export function isMarkerAllowed(marker, ticketBody) {
  if (!ticketBody) return false;
  const needle = `allow-suppression: ${marker}`;
  return ticketBody.includes(needle);
}
