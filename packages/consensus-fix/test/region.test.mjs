/**
 * Tests for region.mjs — windowing a file's content around the lines a test
 * failure actually references, instead of embedding the whole file.
 * Pure — no I/O, no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLineReferences, buildWindows, renderExcerpt, buildFileExcerpt } from '../lib/region.mjs';

function makeLines(n) {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
}

// ── extractLineReferences ───────────────────────────────────────────────────

test('extractLineReferences finds a simple "file:line" reference', () => {
  const refs = extractLineReferences('AssertionError at foo.mjs:42', 'foo.mjs');
  assert.deepEqual(refs, [42]);
});

test('extractLineReferences finds a stack-trace-style "at (file:line:col)" reference', () => {
  const output = '    at Object.<anonymous> (/repo/src/foo.mjs:17:9)';
  const refs = extractLineReferences(output, 'foo.mjs');
  assert.deepEqual(refs, [17]);
});

test('extractLineReferences dedupes and sorts multiple references', () => {
  const output = 'foo.mjs:50\nfoo.mjs:10\nfoo.mjs:50\nfoo.mjs:30';
  const refs = extractLineReferences(output, 'foo.mjs');
  assert.deepEqual(refs, [10, 30, 50]);
});

test('extractLineReferences ignores references to a DIFFERENT file', () => {
  const output = 'bar.mjs:5\nfoo.mjs:99';
  const refs = extractLineReferences(output, 'foo.mjs');
  assert.deepEqual(refs, [99]);
});

test('extractLineReferences returns [] when nothing matches', () => {
  assert.deepEqual(extractLineReferences('no useful output here', 'foo.mjs'), []);
});

test('extractLineReferences handles a basename containing regex-special characters', () => {
  const refs = extractLineReferences('a.b+c.mjs:7', 'a.b+c.mjs');
  assert.deepEqual(refs, [7]);
});

// ── buildWindows ─────────────────────────────────────────────────────────────

test('buildWindows returns [] for no reference lines', () => {
  assert.deepEqual(buildWindows([], 100, 5), []);
});

test('buildWindows builds a single window around one reference, clipped to file bounds', () => {
  assert.deepEqual(buildWindows([50], 100, 5), [[45, 55]]);
});

test('buildWindows clips at the start and end of the file', () => {
  assert.deepEqual(buildWindows([2], 100, 5), [[1, 7]]);
  assert.deepEqual(buildWindows([99], 100, 5), [[94, 100]]);
});

test('buildWindows merges overlapping windows into one', () => {
  // Windows [10,20] and [15,25] overlap -> merge to [10,25].
  assert.deepEqual(buildWindows([15, 20], 100, 5), [[10, 25]]);
});

test('buildWindows merges windows that are merely adjacent (touching, not overlapping)', () => {
  // [10,20] and [21,31] touch at the boundary -> merge, avoids a
  // "... 0 lines omitted ..." gap for a single missing line.
  assert.deepEqual(buildWindows([15, 26], 100, 5), [[10, 31]]);
});

test('buildWindows keeps genuinely separate references as separate windows', () => {
  const windows = buildWindows([10, 90], 100, 3);
  assert.deepEqual(windows, [[7, 13], [87, 93]]);
});

// ── renderExcerpt ────────────────────────────────────────────────────────────

test('renderExcerpt line-numbers the window and marks omitted gaps', () => {
  const content = makeLines(20);
  const text = renderExcerpt(content, [[8, 12]]);
  assert.match(text, /^\.\.\. 7 line\(s\) omitted \.\.\./);
  assert.match(text, /8: line 8/);
  assert.match(text, /12: line 12/);
  assert.match(text, /\.\.\. 8 line\(s\) omitted \.\.\.$/);
  assert.ok(!text.includes('line 7\n') || text.includes('7: line 7') === false, 'line 7 must not appear (it is outside the window)');
});

test('renderExcerpt with a window covering the whole file has no omission markers', () => {
  const content = makeLines(5);
  const text = renderExcerpt(content, [[1, 5]]);
  assert.ok(!text.includes('omitted'));
});

// ── buildFileExcerpt ─────────────────────────────────────────────────────────

test('buildFileExcerpt shows a small file in full, unwindowed', () => {
  const content = makeLines(10);
  const excerpt = buildFileExcerpt({ content, testOutput: '', filePath: 'foo.mjs', smallFileLineThreshold: 40 });
  assert.equal(excerpt.windowed, false);
  assert.equal(excerpt.text, content);
  assert.equal(excerpt.totalLines, 10);
});

test('buildFileExcerpt windows a large file when the test output references a line in it', () => {
  const content = makeLines(200);
  const testOutput = 'Error at foo.mjs:100';
  const excerpt = buildFileExcerpt({ content, testOutput, filePath: 'foo.mjs' });
  assert.equal(excerpt.windowed, true);
  assert.ok(excerpt.text.length < content.length, 'excerpt must be smaller than the full file');
  assert.match(excerpt.text, /100: line 100/);
  assert.equal(excerpt.totalLines, 200);
});

test('buildFileExcerpt falls back to a length-capped tail when no line reference is found for a large file', () => {
  const content = makeLines(200);
  const excerpt = buildFileExcerpt({ content, testOutput: 'no reference to this file', filePath: 'foo.mjs', fallbackMaxChars: 500 });
  assert.equal(excerpt.windowed, true);
  assert.ok(excerpt.text.length <= 500);
  assert.equal(excerpt.totalLines, 200);
});

test('buildFileExcerpt does not window/truncate when the fallback tail already covers the whole (short) file', () => {
  const content = makeLines(50); // just over the default 40-line threshold, but short in chars
  const excerpt = buildFileExcerpt({ content, testOutput: 'no reference', filePath: 'foo.mjs', fallbackMaxChars: 10_000 });
  assert.equal(excerpt.text, content);
  assert.equal(excerpt.windowed, false);
});

test('buildFileExcerpt matches on basename even when filePath is a full/relative path', () => {
  const content = makeLines(200);
  const testOutput = 'Error at /some/repo/src/deep/foo.mjs:150';
  const excerpt = buildFileExcerpt({ content, testOutput, filePath: 'src/deep/foo.mjs' });
  assert.equal(excerpt.windowed, true);
  assert.match(excerpt.text, /150: line 150/);
});
