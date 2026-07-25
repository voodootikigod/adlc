// Terminal cell measurement for the board (plan §5.2 rendering).
//
// The renderer budgets and truncates against a PANE WIDTH, which is measured in
// terminal cells — and a JavaScript string's length is code units, not cells. A
// CJK path measured 80 and occupied ~160, wrapping the line; because the redraw
// is cursor-home rather than an alternate screen, a wrapped line corrupts the
// frame shape on every refresh, not just once.
//
// This is an approximation of Unicode East Asian Width, not a generated UCD
// table: the wide set below covers CJK, Hangul, fullwidth forms and the common
// emoji blocks. It is exact for the inputs a board actually renders (paths,
// ticket ids, branch names) and errs toward calling things narrow, which can
// under-fill a line but never overflows one.

const SEGMENTER = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null;

/** Grapheme clusters, so a combining mark or ZWJ sequence is never split. The
 *  fallback iterates code POINTS, which still cannot split a surrogate pair. */
export function graphemes(text) {
  const value = String(text ?? '');
  if (!value) return [];
  return SEGMENTER ? [...SEGMENTER.segment(value)].map((part) => part.segment) : [...value];
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
  [0x1f300, 0x1f64f], // pictographs and emoticons
  [0x1f680, 0x1f6ff], // transport and map
  [0x1f900, 0x1f9ff], // supplemental symbols and pictographs
  [0x1fa70, 0x1faff], // symbols and pictographs extended-A
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

/** Cells one grapheme cluster occupies: 0, 1, or 2. */
export function clusterWidth(cluster) {
  if (!cluster) return 0;
  // VS16 forces emoji presentation, which is double-width even when the base
  // character (e.g. U+2764) is not in a wide block on its own.
  if (cluster.includes('️')) return 2;
  const code = cluster.codePointAt(0);
  if (inRanges(ZERO, code)) return 0;
  return inRanges(WIDE, code) ? 2 : 1;
}

/** Terminal cells the whole string occupies. */
export const displayWidth = (text) => graphemes(text).reduce((total, cluster) => total + clusterWidth(cluster), 0);

/** Longest prefix fitting `max` cells, cut on cluster boundaries. */
export function truncateToWidth(text, max) {
  if (!(max > 0)) return '';
  let out = '';
  let used = 0;
  for (const cluster of graphemes(text)) {
    const width = clusterWidth(cluster);
    if (used + width > max) break;
    out += cluster;
    used += width;
  }
  return out;
}

/** Longest SUFFIX fitting `max` cells — the identifying end of a path or id. */
export function tailToWidth(text, max) {
  if (!(max > 0)) return '';
  const clusters = graphemes(text);
  let out = '';
  let used = 0;
  for (let index = clusters.length - 1; index >= 0; index -= 1) {
    const width = clusterWidth(clusters[index]);
    if (used + width > max) break;
    out = clusters[index] + out;
    used += width;
  }
  return out;
}
