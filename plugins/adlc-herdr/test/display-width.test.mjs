// Terminal cells are not JavaScript string length. board-render budgeted and
// truncated by `.length`, so a CJK path (two cells per character) measured as
// fitting an 80-column pane and then wrapped — and a wrapped line invalidates
// the renderer's whole frame shape, because the redraw is cursor-home, not an
// alternate screen. Every row shared that assumption, not just the header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ambiguousWideFromEnv, bounded, displayWidth, graphemes, tailToWidth, truncateToWidth } from '../lib/display-width.mjs';
import { boardFooter } from '../lib/board-render.mjs';

test('ASCII width is its length', () => {
  assert.equal(displayWidth('ticket t-b · P4'), 15);
  assert.equal(displayWidth(''), 0);
});

test('CJK and fullwidth characters occupy two cells', () => {
  assert.equal(displayWidth('日本語'), 6);
  assert.equal(displayWidth('한글'), 4);
  assert.equal(displayWidth('ＡＢ'), 4); // fullwidth latin
  assert.equal(displayWidth('a日b'), 4);
});

test('combining marks add no width', () => {
  assert.equal(displayWidth('é'), 1, 'e + combining acute is one cell');
  assert.equal(displayWidth('à́̂'), 1);
});

test('emoji occupy two cells, including ZWJ sequences and VS16', () => {
  assert.equal(displayWidth('🎫'), 2);
  assert.equal(displayWidth('👨‍👩‍👧'), 2, 'a ZWJ family renders as one glyph');
  assert.equal(displayWidth('❤️'), 2, 'variation selector-16 forces emoji presentation');
});

test('emoji blocks a first pass missed are still two cells', () => {
  // Undercounting is the dangerous direction: it lets a row the renderer
  // believes it truncated occupy more cells than the pane and wrap. These are
  // pinned to literal expected widths rather than compared against
  // displayWidth, so the production helper is not its own oracle.
  assert.equal(displayWidth('🇺🇸'), 2, 'a regional-indicator flag is one wide cluster');
  assert.equal(displayWidth('🇺🇸🇯🇵'), 4, 'two flags');
  assert.equal(displayWidth('🟠'), 2, 'geometric shapes extended');
  assert.equal(displayWidth('🀄'), 2, 'mahjong');
  assert.equal(displayWidth('🂡'), 2, 'playing cards');
  assert.equal(displayWidth('🩰'), 2, 'symbols extended-A');
  assert.equal(displayWidth('🧿'), 2, 'supplemental symbols');
});

test('a flag is one cluster, so it can never be half-truncated', () => {
  assert.equal(graphemes('🇺🇸').length, 1);
  assert.equal(truncateToWidth('🇺🇸🇯🇵', 2), '🇺🇸');
  assert.equal(truncateToWidth('🇺🇸🇯🇵', 3), '🇺🇸', 'a wide cluster that would overflow is dropped whole');
});

test('default-presentation emoji below the CJK blocks are two cells', () => {
  // These live below U+2E80, outside every range a hand-written table starts
  // at, and they are extremely common. Pinned to literal widths.
  for (const emoji of ['⚽', '⌚', '⏰', '☔', '⛔', '✅', '➕', '⭐', '⬛']) {
    assert.equal(displayWidth(emoji), 2, `${emoji} must be two cells`);
  }
});

test('East Asian Wide characters outside the emoji property are two cells', () => {
  // \p{Emoji_Presentation} covers the emoji class but says nothing about
  // East_Asian_Width=W, and these fall in the gaps a partial range list leaves:
  // Tangut components, Kana Supplement, Enclosed Ideographic Supplement.
  // Literal expected widths — no displayWidth-as-its-own-oracle.
  assert.equal(displayWidth('\u{16FE0}'), 2, 'Tangut iteration mark');
  assert.equal(displayWidth('\u{1B000}'), 2, 'Kana Supplement');
  assert.equal(displayWidth('\u{1F200}'), 2, 'Enclosed Ideographic Supplement');
  assert.equal(displayWidth('\u{18800}'), 2, 'Tangut components');
  assert.equal(displayWidth('\u{1AFF0}'), 2, 'Kana Extended-B');
  assert.equal(displayWidth('　'), 2, 'ideographic space');
  assert.equal(displayWidth('〉'), 2, 'right-pointing angle bracket');
});

test('the non-emoji wide symbols in the BMP are covered', () => {
  // These are East_Asian_Width=W but NOT emoji-presentation, so the property
  // escape does not reach them and only the table can. Each successive review
  // found another; pinned individually so the set cannot silently shrink.
  assert.equal(displayWidth('☰'), 2, 'U+2630 trigram');
  assert.equal(displayWidth('☷'), 2, 'U+2637 trigram, range end');
  assert.equal(displayWidth('⚊'), 2, 'U+268A monogram');
  assert.equal(displayWidth('⚏'), 2, 'U+268F digram, range end');
  assert.equal(displayWidth('〈'), 2, 'U+2329 angle bracket');
});

test('characters added by later Unicode releases inside covered blocks are wide', () => {
  // Ranges that stop at the last ASSIGNED code point go stale on every Unicode
  // release. These four were added in 15.1, inside blocks the table already
  // covered, and every one of them undercounted. The ranges now follow block
  // boundaries so the next release does not reopen the same hole.
  assert.equal(displayWidth('⿼'), 2, 'U+2FFC, added in Unicode 15.1');
  assert.equal(displayWidth('⿿'), 2, 'U+2FFF, end of the block');
  assert.equal(displayWidth('㇯'), 2, 'U+31EF, added in Unicode 15.1');
  assert.equal(displayWidth('㇤'), 2, 'unassigned inside a wide block counts wide');
});

test('blocks that cannot be verified offline take the wide side', () => {
  // An earlier version of this test asserted U+4DC0 is Neutral and therefore
  // one cell. That classification could not be checked without the UCD data
  // file, and a review reports the block as W. Where the answer is genuinely
  // uncertain the tie goes to WIDE, because over-counting under-fills a row
  // while under-counting wraps it — and a wrapped row corrupts every later
  // refresh. Asserting the unverified narrow answer locked the risky side in.
  assert.equal(displayWidth('䷀'), 2, 'U+4DC0 Yijing hexagram');
  assert.equal(displayWidth('\u{1D300}'), 2, 'U+1D300 Tai Xuan Jing');
  assert.equal(displayWidth('\u{18CFF}'), 2, 'U+18CFF, in the old Khitan gap');
});

test('emoji width does not depend on the runtime ICU version', () => {
  // \p{Emoji_Presentation} reads the Unicode data bundled with the running Node
  // build: 15.1 on Node 18, 16 on Node 22. Emoji added after 15.1 therefore
  // measured 1 cell on the oldest supported runtime and 2 on the newest — the
  // board would wrap on Node 18 in a modern terminal, and no test could see it
  // because the suite ran on Node 22. The emoji planes are covered by an
  // explicit range so the answer is the same on every runtime.
  assert.equal(displayWidth('\u{1FAE9}'), 2, 'added after Unicode 15.1');
  assert.equal(displayWidth('\u{1FAF8}'), 2, 'symbols and pictographs extended-A');
  assert.equal(displayWidth('\u{1F7F0}'), 2, 'symbols and pictographs extended');
  assert.equal(displayWidth('\u{1FAFF}'), 2, 'end of the covered span');
});

test('clearly Ambiguous characters stay one cell', () => {
  // The wide bias is not indiscriminate: East_Asian_Width=A characters are
  // narrow in a non-East-Asian locale, and widening them would shrink every row
  // on every board for no reason. These are unambiguous about being Ambiguous.
  assert.equal(displayWidth('①'), 1, 'U+2460 circled digit');
  assert.equal(displayWidth('°'), 1, 'U+00B0 degree sign');
  assert.equal(displayWidth('§'), 1, 'U+00A7 section sign');
  assert.equal(displayWidth('α'), 1, 'U+03B1 greek small alpha');
});

test('emission never exceeds the real pane, even below the layout floor', () => {
  // clampWidth floors the LAYOUT at 20 so its arithmetic stays sane. That floor
  // was also being used for emission, so a 5-column pane got 20-cell rows and
  // an 18-cell footer — every one of them wrapping, which is exactly what the
  // clamping exists to prevent.
  for (let width = 1; width <= 19; width += 1) {
    const footer = boardFooter(3000, width).replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(displayWidth(footer) <= width, `width ${width}: footer is ${displayWidth(footer)} cells: ${footer}`);
  }
});

test('a keycap without VS16 is still a wide cluster', () => {
  // '1' + U+20E3 is one grapheme that terminals render as a keycap glyph. The
  // enclosing mark is zero-width and the base is ASCII, so measuring by base
  // alone called it one cell.
  assert.equal(displayWidth('1⃣'), 2);
  assert.equal(displayWidth('1️⃣'), 2, 'and with VS16');
});

test('narrow symbols the board itself renders stay one cell', () => {
  // The inverse guard: over-broad emoji classification would make the board's
  // own separators and bullets double-width and shrink every row.
  // NB: the separator is ASCII '-' precisely because U+2500 is ambiguous-width
  // and would render two cells on an East Asian terminal. See board-render.mjs.
  for (const symbol of ['·', '…', '-', '>', ' ']) {
    assert.equal(displayWidth(symbol), 1, `${symbol} must stay one cell`);
  }
});

test('truncation is bounded work, not proportional to a huge untrusted field', () => {
  // Ticket titles are untrusted and have no length limit, and the board
  // re-renders every few seconds. Eagerly expanding a multi-megabyte title into
  // segment objects to keep 40 cells allocated hundreds of MB per redraw.
  const huge = `${'ab'.repeat(2_000_000)}TAIL`;
  const started = process.hrtime.bigint();
  assert.equal(truncateToWidth(huge, 10), 'ababababab');
  assert.equal(tailToWidth(huge, 4), 'TAIL');
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // Measured on this input: lazy ~2ms, eager ~930ms (4,000,004 clusters
  // materialized to keep ten). 200ms sits ~100x above the lazy path and ~5x
  // below the eager one, so it separates the regimes without being tight.
  // A 1000ms bound did NOT: reverting to eager still passed at 927ms.
  assert.ok(ms < 200, `truncating a 4 MB field took ${ms.toFixed(0)}ms — is it still eager?`);
});

test('bounding a field never strands a surrogate half', () => {
  const emoji = '🎫'.repeat(50);
  for (const limit of [1, 2, 3, 7, 20]) {
    const capped = bounded(emoji, limit);
    assert.ok(!/[\uD800-\uDFFF]/.test(capped.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')),
      `limit ${limit}: ${JSON.stringify(capped)}`);
    assert.ok(capped.length <= limit);
  }
  assert.equal(bounded('short', 100), 'short', 'a field under the cap is untouched');
});

test('graphemes keep clusters whole', () => {
  assert.deepEqual(graphemes('a日'), ['a', '日']);
  assert.deepEqual(graphemes('é'), ['é']);
  assert.deepEqual(graphemes('👨‍👩‍👧'), ['👨‍👩‍👧']);
});

test('truncateToWidth never exceeds the budget and never splits a cluster', () => {
  assert.equal(truncateToWidth('日本語', 4), '日本');
  assert.equal(truncateToWidth('日本語', 5), '日本', 'a wide char that would overflow is dropped whole');
  assert.equal(truncateToWidth('abc', 10), 'abc');
  assert.equal(truncateToWidth('éx', 1), 'é', 'the mark travels with its base');
  assert.equal(truncateToWidth('anything', 0), '');
  assert.equal(truncateToWidth('anything', -1), '');
});

test('tailToWidth keeps the END within the budget, on cluster boundaries', () => {
  assert.equal(tailToWidth('日本語', 4), '本語');
  assert.equal(tailToWidth('日本語', 5), '本語');
  assert.equal(tailToWidth('abcdef', 3), 'def');
  assert.equal(tailToWidth('x🎫', 2), '🎫');
  assert.equal(tailToWidth('anything', 0), '');
});

test('no truncation ever emits a lone surrogate', () => {
  const emoji = '🎫'.repeat(20);
  for (let budget = 0; budget <= 12; budget += 1) {
    for (const text of [truncateToWidth(emoji, budget), tailToWidth(emoji, budget)]) {
      const stripped = text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
      assert.ok(!/[\uD800-\uDFFF]/.test(stripped), `budget ${budget}: lone surrogate in ${JSON.stringify(text)}`);
      assert.ok(displayWidth(text) <= budget, `budget ${budget}: width ${displayWidth(text)}`);
    }
  }
});

test('width and truncation agree for every prefix of a mixed string', () => {
  // The property that matters to the renderer: whatever truncateToWidth
  // returns must measure within the budget it was given, for any input.
  const mixed = 'a日b🎫c한édＡ/tmp/x';
  for (let budget = 0; budget <= displayWidth(mixed) + 2; budget += 1) {
    assert.ok(displayWidth(truncateToWidth(mixed, budget)) <= budget, `head budget ${budget}`);
    assert.ok(displayWidth(tailToWidth(mixed, budget)) <= budget, `tail budget ${budget}`);
  }
});

test('a complex-script cluster counts every SPACING code point it contains', () => {
  // Intl.Segmenter returns a Devanagari conjunct as ONE cluster, and measuring
  // it from its first code point called four code points one cell. A terminal
  // allocates cells for the second consonant and the spacing vowel mark, so a
  // row of them measured 40 and occupied far more.
  //
  // Nonspacing (Mn) and enclosing (Me) marks stay free; spacing marks (Mc) do
  // not: ka + virama + ssa + vowel-sign-i = 1 + 0 + 1 + 1.
  assert.equal(displayWidth('क्षि'), 3);
  assert.equal(displayWidth('क'), 1, 'the base consonant alone');
  assert.equal(displayWidth('क्'), 1, 'a virama is nonspacing');
  assert.equal(displayWidth('ก'), 1, 'Thai consonant');
  assert.equal(displayWidth('กิ'), 1, 'Thai vowel sign is nonspacing');
});

test('summing code points does not double-count emoji clusters', () => {
  // The per-code-point sum must not reach the emoji paths: a flag is two
  // regional indicators and a ZWJ family is several wide code points, but each
  // renders as ONE glyph. Summing them would over-shrink every row with emoji.
  assert.equal(displayWidth('\u{1F1FA}\u{1F1F8}'), 2, 'two regional indicators, one glyph');
  assert.equal(displayWidth('\u{1F468}‍\u{1F469}‍\u{1F467}'), 2, 'ZWJ family is one glyph');
  assert.equal(displayWidth('❤️'), 2, 'base plus VS16');
  assert.equal(displayWidth('1⃣'), 2, 'keycap');
});

test('a pathological zero-width cluster cannot bypass the truncation bound', () => {
  // truncateToWidth stopped only when accumulated CELLS exceeded max, and
  // Mn/Me/Cf code points contribute zero — so one base plus thousands of
  // combining marks is a single grapheme that emitted in full into a six-cell
  // row. The cell budget needs a code-unit ceiling behind it.
  const bomb = `a${'́'.repeat(20_000)}`;
  const head = truncateToWidth(bomb, 6);
  const tail = tailToWidth(bomb, 6);
  assert.ok(head.length < 2_000, `head emitted ${head.length} code units for a 6-cell budget`);
  assert.ok(tail.length < 2_000, `tail emitted ${tail.length} code units for a 6-cell budget`);
  assert.ok(displayWidth(head) <= 6);
  assert.ok(displayWidth(tail) <= 6);
});

test('zero-width-only input stays empty rather than accumulating', () => {
  const marks = '́'.repeat(5_000);
  assert.equal(displayWidth(truncateToWidth(marks, 10)), 0);
  assert.ok(truncateToWidth(marks, 10).length < 2_000);
});

test('the block-boundary policy is applied to EVERY range, not just some', () => {
  // Three ranges stayed pinned to assignment endpoints — the exact thing the
  // policy comment 50 lines above them forbids — and Unicode 17 assigned
  // U+16FF2-16FF6 and extended Tangut past U+187F7 straight into those gaps.
  assert.equal(displayWidth('\u{16FF2}'), 2, 'assigned in Unicode 17');
  assert.equal(displayWidth('\u{16FF6}'), 2);
  assert.equal(displayWidth('\u{16FFF}'), 2, 'end of the ideographic symbols block');
  assert.equal(displayWidth('\u{187F8}'), 2, 'Tangut past the old endpoint');
  assert.equal(displayWidth('\u{187FF}'), 2, 'end of the Tangut block');
});

test('ambiguous-width mode is declared, never guessed', () => {
  // Whether U+2460 occupies one cell or two is a terminal/font CONFIGURATION,
  // not a property of the text, so there is nothing to detect. Default narrow,
  // because that is right for the large majority and widening every ambiguous
  // character would shrink every row on every board for everyone else.
  assert.equal(ambiguousWideFromEnv({}), false);
  assert.equal(ambiguousWideFromEnv({ ADLC_HERDR_AMBIGUOUS_WIDTH: 'narrow' }), false);
  assert.equal(ambiguousWideFromEnv({ ADLC_HERDR_AMBIGUOUS_WIDTH: 'wide' }), true);
  assert.equal(ambiguousWideFromEnv(), false, 'a missing env is not an error');
});

test('in ambiguous-wide mode, ambiguous data counts two cells', () => {
  const WIDE_MODE = { ambiguousWide: true };
  assert.equal(displayWidth('①'), 1, 'default stays narrow');
  assert.equal(displayWidth('①', WIDE_MODE), 2);
  assert.equal(displayWidth('°', WIDE_MODE), 2);
  // ASCII is never ambiguous, so rows of plain text keep their full length.
  assert.equal(displayWidth('ticket t-b | P4', WIDE_MODE), 15);
  // Already-classified characters keep their classification.
  assert.equal(displayWidth('日', WIDE_MODE), 2, 'wide stays wide');
  assert.equal(displayWidth('é', WIDE_MODE), 2, 'base is ambiguous, mark still free');
});

test('ambiguous-wide truncation halves what fits, and cannot overflow', () => {
  // The failure this closes: forty circled digits measured 40 cells and
  // occupied 80 on an ambiguous-wide terminal, wrapping the row.
  const WIDE_MODE = { ambiguousWide: true };
  const data = '①'.repeat(40);
  const kept = truncateToWidth(data, 40, WIDE_MODE);
  assert.equal(displayWidth(kept, WIDE_MODE), 40, 'exactly fills the pane in cells');
  assert.equal([...kept].length, 20, 'which is twenty glyphs, not forty');
  assert.equal(displayWidth(tailToWidth(data, 40, WIDE_MODE), WIDE_MODE), 40);
});
