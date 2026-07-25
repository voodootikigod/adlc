// Terminal cells are not JavaScript string length. board-render budgeted and
// truncated by `.length`, so a CJK path (two cells per character) measured as
// fitting an 80-column pane and then wrapped — and a wrapped line invalidates
// the renderer's whole frame shape, because the redraw is cursor-home, not an
// alternate screen. Every row shared that assumption, not just the header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth, graphemes, tailToWidth, truncateToWidth } from '../lib/display-width.mjs';

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
