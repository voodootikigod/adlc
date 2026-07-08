// Markdown fenced-code helpers, shared across the toolkit's text-scanning gates.
//
// A recurring bug class (docs/review-lenses/text-scanning-gates.md): a gate scans
// Markdown/MDX text for something (suppression markers, acceptance-criteria
// headings) but treats a fenced code block as if it were live content, or uses a
// naive delimiter toggle that desyncs on nested fences. Both rails-guard's `.mdx`
// suppression scan and spec-lint's criteria parser hit it. This module is the one
// authoritative implementation of CommonMark fenced-code semantics they share.

/**
 * Match a fenced-code OPENER: up to 3 spaces of indent, then a run of ≥3 backticks
 * or ≥3 tildes, then an optional info string. Returns { char, len } or null.
 * A backtick opener whose info string contains a backtick is NOT a valid fence
 * (CommonMark) — that guards against inline ```` ``` ```` runs being read as openers.
 */
export function matchFenceOpen(line) {
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
export function isFenceClose(line, char, len) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  return Boolean(m) && m[1][0] === char && m[1].length >= len;
}

/**
 * Compute the set of 1-based line numbers that fall INSIDE a Markdown fenced code
 * block, given the FULL file content, using CommonMark fenced-code semantics (a
 * closer must match the opener's fence character and be at least as long).
 *
 * Fence-delimiter lines are NOT included (they carry no content of interest); only
 * the inert interior lines are. An unclosed fence extends to end-of-file. Only
 * fenced blocks are recognized — INDENTED code blocks are deliberately NOT (MDX
 * disables them; a 4-space-indented line can be live JSX there).
 *
 * Line endings are normalized: lines are split on `\n` (keeping 1-based numbers in
 * lockstep with a `\n`-based diff parser) and a trailing `\r` is stripped, so a
 * CRLF fence closer is recognized (`` ```\r `` still closes). A pathological
 * EMBEDDED `\r` (a bare CR mid-line, which git does not treat as a break but
 * micromark does) FAILS CLOSED: the fence is force-closed and the line is treated
 * as live content, never silently as inert.
 *
 * `unclosedToEof` controls the fail direction for an UNCLOSED fence (opener with no
 * closer). It exists because the two safety polarities are opposite per consumer:
 *   - true (default) — the interior extends to end-of-file. Correct for an MDX
 *     suppression scan, where "fenced" means "exempt": MDX itself compiles an
 *     unclosed fence as a code block to EOF, so those markers are genuinely inert.
 *   - false — an unclosed fence marks NOTHING (its lines are live content). Correct
 *     for a consumer that SKIPS fenced lines from a gate (e.g. spec-lint's criteria
 *     scan): there, a stray ``` swallowing the rest of the file would silently drop
 *     real content and weaken the gate. "Fail closed" for such a consumer means
 *     scanning the ambiguous lines, not exempting them.
 *
 * @param {string} content  full file text
 * @param {object} [opts]
 * @param {boolean} [opts.unclosedToEof=true]  see above
 * @returns {Set<number>}
 */
export function computeFencedLines(content, { unclosedToEof = true } = {}) {
  const fenced = new Set();
  if (typeof content !== 'string' || content === '') return fenced;
  const lines = content.split('\n');
  let fence = null; // { char, len } while inside a fence, else null
  let pending = []; // interior lines of the current, not-yet-closed fence
  const commit = () => { for (const n of pending) fenced.add(n); pending = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r+$/, ''); // normalize CRLF / trailing CR run
    if (line.includes('\r')) {
      // embedded bare CR — cannot reason about line breaks; fail closed by
      // force-closing (interior seen so far was legitimately fenced → commit it).
      if (fence !== null) commit();
      fence = null;
      continue;
    }
    if (fence === null) {
      fence = matchFenceOpen(line); // opener line itself is not marked
      continue;
    }
    if (isFenceClose(line, fence.char, fence.len)) {
      commit(); // closed → interior is inert; closer line itself is not marked
      fence = null;
      continue;
    }
    pending.push(i + 1); // interior line, 1-based (committed only when the fence closes)
  }
  // An unclosed fence at EOF: commit its interior only when the caller wants it.
  if (fence !== null && unclosedToEof) commit();
  return fenced;
}
