// parse.mjs — extract acceptance criteria from a markdown spec file.
// Pure functions; no I/O.

import { computeFencedLines } from '@adlc/core';

/**
 * Headings that introduce an acceptance criteria section.
 * @type {RegExp}
 */
const CRITERIA_HEADING_RE = /acceptance|criteria|requirements|definition of done|success/i;

/**
 * A bold-only pseudo-heading line, e.g. "**Acceptance criteria**:" or
 * "**Requirements**". Scoped to a line containing ONLY the bold label
 * (with an optional trailing colon) so it doesn't false-trigger on a bold
 * phrase embedded mid-sentence (see #71).
 *
 * The label group is `(?:(?!\*\*).)+` rather than a plain lazy `.+?`: a
 * lazy quantifier is still willing to backtrack across an *interior*
 * `**...**` pair to satisfy the trailing `\*\*:?\s*$` anchor, so a prose
 * line containing two unrelated bold spans — e.g.
 * "**Login** endpoint must return **401**" — would otherwise match, with
 * the whole "Login** endpoint must return **401" swallowed into the
 * capture group. That silently flips `inCriteriaSection` to false (since
 * the bogus label doesn't match CRITERIA_HEADING_RE) and drops every
 * criterion after it even though no real heading intervened (review
 * round 3 / #71 follow-up). Forbidding `**` inside the label means the
 * regex only matches a line that is a *single* bold span from start to
 * end, which is what a genuine pseudo-heading looks like.
 *
 * Deliberately anchored with NO leading whitespace tolerance: a real
 * pseudo-heading is a top-level line, not something nested inside a list
 * item's body. If this were allowed to match indented text, an indented
 * bold-only aside embedded in a bullet's wrapped body (e.g. "  **Note**"
 * on its own physical line) would be excluded from continuation-line
 * absorption by isContinuationLine() and then get reprocessed by the
 * outer loop as a section-toggling pseudo-heading, silently ending the
 * criteria section and dropping every criterion after it (see #71/#45
 * follow-up).
 */
const BOLD_HEADING_RE = /^\*\*((?:(?!\*\*).)+)\*\*:?\s*$/;

/**
 * List-item prefixes: -, *, 1., 2., …, - [ ], - [x]
 * Matches the leading marker and optional checkbox, capturing rest of line.
 */
const LIST_ITEM_RE = /^[ \t]*(?:[-*]|\d+\.)(?:\s+\[[ xX]\])?\s+(.+)/;

/**
 * A standalone MUST / SHOULD line (not inside a list).
 * Matches lines that start with MUST or SHOULD (possibly after whitespace).
 */
const MUST_SHOULD_RE = /^[ \t]*(MUST|SHOULD)\b(.+)/;

/**
 * A literal markdown heading line, e.g. "## Acceptance Criteria".
 */
const HEADING_RE = /^#{1,6}\s+/;

/**
 * Whether `line` is a wrapped continuation of the preceding list item:
 * non-blank, indented, and not itself a new list marker/heading/pseudo-heading/
 * standalone MUST-SHOULD criterion.
 *
 * A standalone MUST/SHOULD line must always be emitted as its own criterion
 * (see parseCriteria's unconditional MUST_SHOULD_RE pass below) — even when
 * it's indented and immediately follows a list bullet with no blank line in
 * between, it must NOT be absorbed into the preceding bullet's text (#71
 * follow-up: this previously hid genuine WISH-classified MUST/SHOULD lines).
 *
 * @param {string} line
 * @returns {boolean}
 */
function isContinuationLine(line) {
  if (line.trim() === '') return false;
  if (HEADING_RE.test(line)) return false;
  if (BOLD_HEADING_RE.test(line)) return false;
  if (LIST_ITEM_RE.test(line)) return false;
  if (MUST_SHOULD_RE.test(line)) return false;
  return /^[ \t]+\S/.test(line);
}

/**
 * Parse a markdown string and return an array of criterion objects.
 *
 * @param {string} text  Full markdown content.
 * @returns {Array<{line: number, text: string, source: 'list'|'must-should'}>}
 */
export function parseCriteria(text) {
  const lines = text.split('\n');
  // Lines inside a fenced code block are illustrative example markdown, not spec
  // structure. Scanning them lets a heading-like line inside a fence desync the
  // section (silently dropping real criteria after it) and turns example list/MUST
  // lines into phantom criteria — audit finding E, the rails-guard fence class
  // applied to spec-lint. See docs/review-lenses/text-scanning-gates.md.
  //
  // unclosedToEof:false — an UNCLOSED fence must NOT swallow the rest of the spec.
  // Skipping is an exemption here, so a stray ``` extending to EOF would silently
  // drop every real criterion after it (a false PASS). Fail closed = scan those
  // lines: an unterminated fence marks nothing.
  const fenced = computeFencedLines(text, { unclosedToEof: false });
  const criteria = [];
  let inCriteriaSection = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1; // 1-based

    // Inside a fence: neither section-toggling nor capturable. Skip entirely.
    if (fenced.has(lineNo)) continue;

    // Heading detection — switch section context.
    if (HEADING_RE.test(raw)) {
      const heading = raw.replace(HEADING_RE, '').trim();
      inCriteriaSection = CRITERIA_HEADING_RE.test(heading);
      continue;
    }

    // Bold-only pseudo-heading — a line that is nothing but a bold label
    // (e.g. "**Acceptance criteria**:") acts like a heading for section
    // detection purposes (#71).
    const boldHeadingMatch = BOLD_HEADING_RE.exec(raw);
    if (boldHeadingMatch) {
      inCriteriaSection = CRITERIA_HEADING_RE.test(boldHeadingMatch[1]);
      continue;
    }

    if (inCriteriaSection) {
      const listMatch = LIST_ITEM_RE.exec(raw);
      if (listMatch) {
        // Join wrapped continuation lines into this same logical criterion,
        // matching how markdown renderers treat a single list item (#71).
        let combinedText = listMatch[1].trim();
        let j = i + 1;
        while (j < lines.length && !fenced.has(j + 1) && isContinuationLine(lines[j])) {
          combinedText += ' ' + lines[j].trim();
          j++;
        }
        criteria.push({ line: lineNo, text: combinedText, source: 'list' });
        i = j - 1; // skip over the consumed continuation lines
        continue;
      }
    }

    // Standalone MUST / SHOULD lines are always captured, regardless of section.
    const msMatch = MUST_SHOULD_RE.exec(raw);
    if (msMatch) {
      criteria.push({ line: lineNo, text: raw.trim(), source: 'must-should' });
    }
  }

  return criteria;
}
