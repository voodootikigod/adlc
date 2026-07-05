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
 */
export function parseAddedLines(diffText) {
  const lines = diffText.split('\n');
  const results = [];
  let currentFile = null;
  let newLineNo = 0;

  for (const raw of lines) {
    // New file header: +++ b/path/to/file
    if (raw.startsWith('+++ ')) {
      const fileMatch = raw.match(/^\+\+\+ (?:b\/)?(.+)$/);
      currentFile = fileMatch ? fileMatch[1] : null;
      newLineNo = 0;
      continue;
    }

    // Hunk header: @@ -a,b +c,d @@
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) newLineNo = parseInt(m[1], 10) - 1;
      continue;
    }

    // Context line
    if (raw.startsWith(' ')) {
      newLineNo++;
      continue;
    }

    // Removed line — does not count in new side
    if (raw.startsWith('-')) {
      continue;
    }

    // Added line
    if (raw.startsWith('+')) {
      newLineNo++;
      if (currentFile !== null) {
        results.push({ file: currentFile, lineNo: newLineNo, content: raw.slice(1) });
      }
      continue;
    }
  }

  return results;
}

/**
 * Match a fenced-code OPENER: up to 3 spaces of indent, then a run of ≥3 backticks
 * or ≥3 tildes, then an optional info string. Returns { char, len } or null.
 * A backtick opener whose info string contains a backtick is NOT a valid fence
 * (CommonMark) — that guards against inline ```` ``` ```` runs being read as openers.
 */
function matchFenceOpen(line) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!m) return null;
  const char = m[1][0];
  if (char === '`' && m[2].includes('`')) return null;
  return { char, len: m[1].length };
}

/**
 * True when `line` CLOSES an open fence of `char`/`len`: same fence character, a
 * run at least as long as the opener, up to 3 spaces of indent, and nothing after
 * the run but whitespace (CommonMark forbids an info string on a closer). A run
 * that is too short — e.g. a ```` ``` ```` line inside a ```` ```` ```` fence — does
 * NOT close it and stays interior content. This is what makes the scan authoritative
 * rather than a naive toggle that desyncs on nested fences of differing lengths.
 */
function isFenceClose(line, char, len) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  return Boolean(m) && m[1][0] === char && m[1].length >= len;
}

/**
 * Compute the set of 1-based line numbers that fall INSIDE a Markdown fenced code
 * block, given the FULL file content, using CommonMark fenced-code semantics (a
 * closer must match the opener's fence character and be at least as long). This is
 * authoritative for `.mdx` FENCED blocks: MDX compiles fenced code to inert
 * `<pre><code>` text, and follows these same rules. NOTE: only fenced blocks are
 * exempted — INDENTED code blocks are deliberately NOT, because MDX disables them
 * (indentation is JSX there), so a 4-space-indented marker can be operative.
 *
 * Fence-delimiter lines are NOT included (they carry no marker); only the inert
 * interior lines are. An unclosed fence extends to end-of-file.
 *
 * Line endings are normalized: lines are split on `\n` (to keep 1-based numbers in
 * lockstep with the `\n`-based diff parser) and a trailing `\r` is stripped, so a
 * CRLF fence closer is recognized (`` ```\r `` still closes) — MDX/micromark treat
 * `\r\n` as a line ending, and a `\r` clinging to a delimiter must not defeat the
 * anchors. A pathological EMBEDDED `\r` (a bare CR mid-line, which git does not
 * treat as a line break but micromark does) fails CLOSED: the fence is force-closed
 * and the line is scanned, never silently treated as inert.
 *
 * @param {string} content  full file text
 * @returns {Set<number>}
 */
export function computeFencedLines(content) {
  const fenced = new Set();
  if (typeof content !== 'string' || content === '') return fenced;
  const lines = content.split('\n');
  let fence = null; // { char, len } while inside a fence, else null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r+$/, ''); // normalize CRLF / trailing CR run
    if (line.includes('\r')) {
      fence = null; // embedded bare CR — cannot reason about MDX line breaks; fail closed
      continue;
    }
    if (fence === null) {
      fence = matchFenceOpen(line); // opener line itself is not marked
      continue;
    }
    if (isFenceClose(line, fence.char, fence.len)) {
      fence = null; // closer line itself is not marked
      continue;
    }
    fenced.add(i + 1); // interior line, 1-based
  }
  return fenced;
}

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
