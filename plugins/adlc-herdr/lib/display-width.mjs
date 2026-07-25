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

const WIDE = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana through CJK compatibility
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x17000, 0x18aff], // Tangut
  [0x1f000, 0x1f0ff], // mahjong, dominoes, playing cards
  [0x1f1e6, 0x1f1ff], // regional indicators — a flag is one cluster, two cells
  // One span rather than the per-block list an earlier revision used: the gaps
  // between those blocks (geometric shapes extended, symbols extended-A) are
  // where the undercount lived, and every character in this range that a board
  // could render is emoji-presentation.
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd], // CJK extensions B and beyond
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

/** Cells one grapheme cluster occupies: 0, 1, or 2. */
export function clusterWidth(cluster) {
  if (!cluster) return 0;
  // VS16 forces emoji presentation, which is double-width even when the base
  // character (e.g. U+2764) is not emoji-presentation on its own.
  if (cluster.includes('️')) return 2;
  if (EMOJI_PRESENTATION.test(cluster)) return 2;
  const code = cluster.codePointAt(0);
  if (inRanges(ZERO, code)) return 0;
  return inRanges(WIDE, code) ? 2 : 1;
}

/** Terminal cells the whole string occupies. */
export function displayWidth(text) {
  let total = 0;
  for (const cluster of clusters(text)) total += clusterWidth(cluster);
  return total;
}

/** Longest prefix fitting `max` cells, cut on cluster boundaries. Stops at the
 *  budget, so the work is proportional to `max` rather than to the input. */
export function truncateToWidth(text, max) {
  if (!(max > 0)) return '';
  let out = '';
  let used = 0;
  for (const cluster of clusters(text)) {
    const width = clusterWidth(cluster);
    if (used + width > max) break;
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
export function tailToWidth(text, max) {
  if (!(max > 0)) return '';
  const value = String(text ?? '');
  const window = value.length <= max * 32 + 64
    ? value
    : trimLeadingLowSurrogate(value.slice(value.length - (max * 32 + 64)));
  const parts = [...clusters(window)];
  let out = '';
  let used = 0;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const width = clusterWidth(parts[index]);
    if (used + width > max) break;
    out = parts[index] + out;
    used += width;
  }
  return out;
}

const trimLeadingLowSurrogate = (value) => {
  const code = value.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff ? value.slice(1) : value;
};
