/**
 * Rail density computation.
 *
 * railDensity = distinct(rails) / distinct(scope)  clamped to [0, 1]
 * Only distinct, non-blank string patterns count on either side.
 * If the ticket has no rails array (or no usable rail), density = 0.
 * If the ticket has rails but no scope array (or it is empty), density = 0 —
 * NOT 1: the old max(1, scope.length) denominator made an unbounded ticket
 * look perfectly railed and routed it to the cheapest tier (#698).
 */

// Whitespace, format and control characters, and Default_Ignorable code
// points (zero-width space, word joiner, Hangul fillers, ...) render as
// nothing; trim() strips only the first of these.
const INVISIBLE = /[\s\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * The distinct, readable path patterns in a rails/scope field. Raw array
 * length is not coverage: rails [""], ["\u200b"] or ["a","a","a"] would score
 * a ticket as fully railed and route unbounded work to the cheap tier. A
 * pattern counts only if, with invisibles removed, it still names something —
 * a letter, a digit, or a glob metacharacter (`**` is a legitimate if blunt
 * rail; the Braille blank U+2800 is not).
 */
function usablePatterns(field) {
  if (!Array.isArray(field)) return 0;
  const seen = new Set();
  for (const item of field) {
    if (typeof item !== 'string') continue;
    const visible = item.replace(INVISIBLE, '');
    if (!/[\p{L}\p{N}*?]/u.test(visible)) continue;
    seen.add(visible);
  }
  return seen.size;
}

/** Compute the rail density for a single ticket. */
export function railDensity(ticket) {
  const rails = usablePatterns(ticket.rails);
  if (rails === 0) return 0;
  const scope = usablePatterns(ticket.scope);
  if (scope === 0) return 0;
  return Math.min(1, rails / scope);
}
