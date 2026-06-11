// parse.mjs — extract acceptance criteria from a markdown spec file.
// Pure functions; no I/O.

/**
 * Headings that introduce an acceptance criteria section.
 * @type {RegExp}
 */
const CRITERIA_HEADING_RE = /acceptance|criteria|requirements|definition of done|success/i;

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
 * Parse a markdown string and return an array of criterion objects.
 *
 * @param {string} text  Full markdown content.
 * @returns {Array<{line: number, text: string, source: 'list'|'must-should'}>}
 */
export function parseCriteria(text) {
  const lines = text.split('\n');
  const criteria = [];
  let inCriteriaSection = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1; // 1-based

    // Heading detection — switch section context.
    if (/^#{1,6}\s+/.test(raw)) {
      const heading = raw.replace(/^#{1,6}\s+/, '').trim();
      inCriteriaSection = CRITERIA_HEADING_RE.test(heading);
      continue;
    }

    if (inCriteriaSection) {
      const listMatch = LIST_ITEM_RE.exec(raw);
      if (listMatch) {
        criteria.push({ line: lineNo, text: listMatch[1].trim(), source: 'list' });
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
