// Terminal cell measurement for the board (plan §5.2 rendering).
//
// The renderer budgets and truncates against a PANE WIDTH, which is measured in
// terminal cells — and a JavaScript string's length is code units, not cells. A
// CJK path measured 80 and occupied ~160, wrapping the line; because the redraw
// is cursor-home rather than an alternate screen, a wrapped line corrupts the
// frame shape on every refresh, not just once.
//
// This is an approximation of Unicode East Asian Width, not a generated UCD
// table. It errs toward calling things WIDE, and the direction is the whole
// point: over-counting under-fills a line, while under-counting hands back a
// row the renderer believes it truncated and the terminal then wraps. An
// earlier revision claimed the opposite and omitted regional indicators, so a
// title of flag emoji measured 30 cells and occupied 70.

const SEGMENTER = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null;

/**
 * Grapheme clusters, LAZILY, so a combining mark or ZWJ sequence is never split.
 *
 * Laziness is not a micro-optimization: ticket titles are untrusted and have no
 * length limit, and the board re-renders every few seconds. Spreading the
 * Segments object expanded a multi-megabyte title into millions of objects to
 * keep 40 cells. Iterating it finds boundaries on demand, so a truncation that
 * stops at its budget does work proportional to the BUDGET, not the input.
 *
 * The fallback iterates code POINTS, which still cannot split a surrogate pair.
 */
function* clusters(text) {
  const value = String(text ?? '');
  if (!value) return;
  if (SEGMENTER) {
    for (const part of SEGMENTER.segment(value)) yield part.segment;
    return;
  }
  yield* value;
}

/** Materialized clusters. Prefer the width helpers below for untrusted input. */
export const graphemes = (text) => [...clusters(text)];

/** Cap an untrusted field before any width work, without stranding a surrogate
 *  half at the cut. */
export function bounded(text, maxCodeUnits) {
  const value = String(text ?? '');
  if (!(maxCodeUnits > 0)) return '';
  if (value.length <= maxCodeUnits) return value;
  const code = value.charCodeAt(maxCodeUnits - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? maxCodeUnits - 1 : maxCodeUnits;
  return value.slice(0, end);
}

/**
 * East_Asian_Width W and F, as published in the Unicode character database.
 *
 * POLICY: ranges follow BLOCK boundaries, not the last assigned code point in
 * each block. A table pinned to assignments goes stale on every Unicode
 * release — 15.1 added U+2FFC-2FFF and U+31EF inside blocks this table already
 * covered, and both undercounted because the ranges stopped at the previous
 * last-assigned character. Unassigned positions inside a wide block therefore
 * count as wide, which is the direction that under-fills rather than wraps.
 *
 * Transcribed rather than hand-picked: successive revisions of a "common blocks"
 * list kept leaving gaps (Kana Supplement, Enclosed Ideographic Supplement,
 * Tangut components, geometric shapes extended), and every gap is an undercount,
 * which is the direction that overflows a line. The emoji class is NOT listed
 * here — \p{Emoji_Presentation} above covers it from the engine's own data, so
 * this table only has to carry the non-emoji wide characters.
 */
const WIDE = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2329, 0x232a], // angle brackets
  [0x2630, 0x2637], // trigrams
  [0x268a, 0x268f], // monograms and digrams
  [0x2e80, 0x2e99], // CJK radicals supplement
  [0x2e9b, 0x2ef3],
  [0x2f00, 0x2fd5], // Kangxi radicals
  // Whole block, not the assigned range: Unicode 15.1 added U+2FFC-2FFF here,
  // and a table pinned to the previous last-assigned code point silently
  // undercounted them. See the block-boundary policy above.
  [0x2ff0, 0x2fff], // ideographic description characters
  [0x3000, 0x303e], // CJK symbols and punctuation (incl. ideographic space)
  [0x3041, 0x3096], // Hiragana
  [0x3099, 0x30ff], // combining kana marks, Katakana
  [0x3105, 0x312f], // Bopomofo
  [0x3131, 0x318e], // Hangul compatibility Jamo
  // Kanbun, Bopomofo Extended, CJK Strokes, Katakana Phonetic Extensions and
  // Enclosed CJK as one span. The gap this closes held U+31EF, added in 15.1;
  // the unassigned positions inside it default to wide, which is the safe side.
  [0x3190, 0x321e],
  [0x3220, 0x3247],
  [0x3250, 0x4dbf], // enclosed CJK, CJK extension A
  // Yijing hexagrams. Earlier revisions of this file (and a test) asserted this
  // block is Neutral. That could not be verified offline and a review reports
  // it as W, so it takes the safe side: over-counting under-fills a row,
  // under-counting wraps it.
  [0x4dc0, 0x4dff],
  [0x4e00, 0xa48c], // CJK unified ideographs, Yi syllables
  [0xa490, 0xa4c6], // Yi radicals
  [0xa960, 0xa97c], // Hangul Jamo extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe52], // CJK compatibility forms
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff01, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  // These three were the last ranges still pinned to assignment endpoints —
  // the exact thing the policy above forbids, 50 lines above them. Unicode 17
  // assigned U+16FF2-16FF6 and extended Tangut past U+187F7, and both landed in
  // the gaps that left. Whole blocks now.
  [0x16fe0, 0x16fff], // ideographic symbols and punctuation
  [0x17000, 0x187ff], // Tangut
  // Tangut components, Khitan Small Script and Tangut Supplement as one span
  // (block boundaries, per the policy above — U+18CFF sat in the old gap).
  [0x18800, 0x18dff],
  [0x1aff0, 0x1affe], // Kana extended-B
  [0x1b000, 0x1b2ff], // Kana supplement, Kana extended-A, Nushu
  [0x1d300, 0x1d37f], // Tai Xuan Jing symbols, counting rod numerals
  [0x1f000, 0x1f0ff], // mahjong, dominoes, cards — deliberately over-counted
  [0x1f1e6, 0x1f1ff], // regional indicators — a flag is one cluster, two cells
  [0x1f200, 0x1f265], // enclosed ideographic supplement
  // The emoji planes, covered EXPLICITLY rather than left to the property
  // escape below. \p{Emoji_Presentation} reads whichever Unicode version the
  // running Node bundles — 15.1 on Node 18, 16 on Node 22 — so an emoji added
  // after 15.1 measured one cell on the oldest supported runtime and two on the
  // newest. A width helper whose answer depends on the interpreter is a width
  // helper that wraps rows on somebody's machine and nowhere else.
  [0x1f300, 0x1faff],
  [0x20000, 0x2fffd], // CJK extension B and beyond
  [0x30000, 0x3fffd],
];

const ZERO = [
  [0x0300, 0x036f], // combining diacriticals
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x06d6, 0x06dc],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x1ab0, 0x1aff], // combining diacriticals extended
  [0x1dc0, 0x1dff], // combining diacriticals supplement
  [0x200b, 0x200f], // zero-width space, ZWNJ, ZWJ, directional marks
  [0x20d0, 0x20ff], // combining marks for symbols
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
];

const inRanges = (ranges, code) => ranges.some(([low, high]) => code >= low && code <= high);

/**
 * Characters the Unicode data says render as emoji by default — ⚽ ⌚ ⏰ ☔ ⛔ ✅
 * and friends, all two cells and all below U+2E80, so no CJK range reaches
 * them. Asking the engine beats extending the table by hand: this is the same
 * UCD the terminal's font stack consults, and it is the class a hand-written
 * list keeps missing.
 */
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}/u;

/**
 * Marks and format controls that occupy no cell of their own: nonspacing (Mn),
 * enclosing (Me) and format (Cf, which includes ZWJ and the bidi controls).
 *
 * General_Category, unlike Emoji_Presentation, is stable across ICU versions
 * for every script a board could plausibly render, so reading it from the
 * engine does not reintroduce the runtime skew the emoji ranges above avoid.
 * SPACING marks (Mc) are deliberately absent: a Devanagari vowel sign takes a
 * cell.
 */
const ZERO_CATEGORY = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/**
 * Whether this terminal renders East_Asian_Width=AMBIGUOUS characters as two
 * cells. There is no way to detect it — it is a terminal/font configuration,
 * not a property of the text — so it is declared, not guessed.
 *
 * ADLC_HERDR_AMBIGUOUS_WIDTH=wide turns it on. Default narrow, because that is
 * correct for the large majority and counting ambiguous characters as wide
 * would shrink every row on every board for everyone else.
 */
export const ambiguousWideFromEnv = (env = {}) => env.ADLC_HERDR_AMBIGUOUS_WIDTH === 'wide';

/**
 * Cells one grapheme cluster occupies: 0, 1, or 2.
 *
 * In ambiguous-wide mode anything non-ASCII that is not already classified
 * counts as two. That is deliberately conservative rather than table-driven:
 * enabling the mode is a statement that wrapping is worse than under-filling,
 * and a full East_Asian_Width=A table is the same hand-maintained data that
 * kept going stale. Over-counting costs a few columns; under-counting corrupts
 * the frame on every refresh.
 */
export function clusterWidth(cluster, { ambiguousWide = false } = {}) {
  if (!cluster) return 0;
  // VS16 forces emoji presentation, which is double-width even when the base
  // character (e.g. U+2764) is not emoji-presentation on its own.
  if (cluster.includes('️')) return 2;
  // U+20E3 turns its base into a keycap glyph, which terminals render wide even
  // when the base is ASCII and no VS16 is present ('1' + U+20E3).
  if (cluster.includes('⃣')) return 2;
  if (EMOJI_PRESENTATION.test(cluster)) return 2;

  // Everything above renders as ONE glyph however many code points it holds —
  // a flag is two regional indicators, a ZWJ family is several. Below here a
  // cluster is ordinary text, and its width is the sum of its parts: measuring
  // from the first code point alone called the four-code-point Devanagari
  // conjunct क्षि one cell when a terminal gives it three.
  let total = 0;
  for (const character of cluster) {
    const code = character.codePointAt(0);
    if (ZERO_CATEGORY.test(character) || inRanges(ZERO, code)) continue;
    if (inRanges(WIDE, code)) { total += 2; continue; }
    total += ambiguousWide && code > 0x7f ? 2 : 1;
  }
  return total;
}

/** Terminal cells the whole string occupies. */
export function displayWidth(text, options) {
  let total = 0;
  for (const cluster of clusters(text)) total += clusterWidth(cluster, options);
  return total;
}

/**
 * A cell budget alone does not bound OUTPUT. Mn/Me/Cf code points cost zero
 * cells, and a base plus thousands of combining marks is a single grapheme, so
 * a six-cell row could still emit thousands of code units — every three
 * seconds, for every visible row. This ceiling is the second bound: generous
 * against real text (a cluster needs a handful of code points) and firm against
 * a title built to exploit the first one.
 */
const codeUnitCeiling = (max) => max * 16 + 64;

/** Longest prefix fitting `max` cells, cut on cluster boundaries. Stops at the
 *  budget, so the work is proportional to `max` rather than to the input. */
export function truncateToWidth(text, max, options) {
  if (!(max > 0)) return '';
  const ceiling = codeUnitCeiling(max);
  let out = '';
  let used = 0;
  for (const cluster of clusters(text)) {
    const width = clusterWidth(cluster, options);
    if (used + width > max) break;
    if (out.length + cluster.length > ceiling) break;
    out += cluster;
    used += width;
  }
  return out;
}

/**
 * Longest SUFFIX fitting `max` cells — the identifying end of a path or id.
 *
 * A suffix cannot be found without reaching the end, so the input is bounded
 * FIRST. `max` cells need at most `max` clusters; the slack covers even absurd
 * ZWJ sequences, and the cut lands arbitrarily far from the tail that survives.
 */
export function tailToWidth(text, max, options) {
  if (!(max > 0)) return '';
  const value = String(text ?? '');
  const window = value.length <= max * 32 + 64
    ? value
    : trimLeadingLowSurrogate(value.slice(value.length - (max * 32 + 64)));
  const parts = [...clusters(window)];
  const ceiling = codeUnitCeiling(max);
  let out = '';
  let used = 0;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const width = clusterWidth(parts[index], options);
    if (used + width > max) break;
    if (out.length + parts[index].length > ceiling) break;
    out = parts[index] + out;
    used += width;
  }
  return out;
}

const trimLeadingLowSurrogate = (value) => {
  const code = value.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff ? value.slice(1) : value;
};
