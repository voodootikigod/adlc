// changedLinesFromDiff must classify hunk body lines by their first character
// only, and usageFromGemini must count thinking tokens as billed output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedLinesFromDiff, classifyDiffBodyLine } from '../lib/mutate.mjs';
import { usageFromGemini } from '../lib/llm.mjs';

const hdr = (f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n`;

test('AC1: a deleted "---" source line (rendered "----") does not shift later lines', () => {
  const diff = `${hdr('x.js')}@@ -1,4 +1,4 @@\n const a = 1;\n----\n+const b = 2;\n const c = 3;\n`;
  assert.deepEqual([...changedLinesFromDiff(diff)['x.js']], [2]);
});

test('AC1: a deleted "--primary: red;" line is a deletion, not context', () => {
  const diff = `${hdr('s.css')}@@ -1,3 +1,3 @@\n a {\n---primary: red;\n+  color: blue;\n }\n`;
  assert.deepEqual([...changedLinesFromDiff(diff)['s.css']], [2]);
});

test('AC2: an added "++x" source line (rendered "+++x") is in the changed set', () => {
  const diff = `${hdr('x.js')}@@ -1,2 +1,3 @@\n a\n+++x\n b\n`;
  assert.deepEqual([...changedLinesFromDiff(diff)['x.js']], [2]);
});

test('AC2: an added "++ b/y" source line is not mistaken for a file header', () => {
  const diff = `${hdr('x.js')}@@ -1,1 +1,2 @@\n a\n+++ b/y.js\n`;
  const r = changedLinesFromDiff(diff);
  assert.deepEqual(Object.keys(r), ['x.js']);
  assert.deepEqual([...r['x.js']], [2]);
});

test('AC3: multi-hunk multi-file diffs give exact sets', () => {
  const diff =
    `${hdr('a.js')}@@ -1,3 +1,3 @@\n k\n----\n+n\n k2\n@@ -10,2 +10,3 @@\n m\n+++p\n z\n` +
    `${hdr('b.js')}@@ -5,2 +5,2 @@\n q\n-old\n+new\n`;
  const r = changedLinesFromDiff(diff);
  assert.deepEqual([...r['a.js']], [2, 11]);
  assert.deepEqual([...r['b.js']], [6]);
});

test('AC3: ordinary diffs, no-newline markers and deleted files are unchanged', () => {
  const diff =
    `${hdr('a.js')}@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n` +
    'diff --git a/gone.js b/gone.js\ndeleted file mode 100644\n--- a/gone.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n';
  const r = changedLinesFromDiff(diff);
  assert.deepEqual([...r['a.js']], [2]);
  assert.deepEqual(Object.keys(r), ['a.js']);
});

test('classifyDiffBodyLine: first character decides', () => {
  assert.equal(classifyDiffBodyLine('+++x'), 'add');
  assert.equal(classifyDiffBodyLine('----'), 'delete');
  assert.equal(classifyDiffBodyLine(' ctx'), 'context');
  assert.equal(classifyDiffBodyLine(''), 'context');
  assert.equal(classifyDiffBodyLine('\\ No newline at end of file'), 'marker');
});

test('AC4: thinking tokens are folded into outputTokens (exact)', () => {
  // Shape of a Gemini usageMetadata object carrying reasoning tokens.
  const raw = { promptTokenCount: 100, candidatesTokenCount: 16, thoughtsTokenCount: 47, cachedContentTokenCount: 5, totalTokenCount: 163 };
  assert.deepEqual(usageFromGemini(raw), { inputTokens: 100, outputTokens: 63, cachedTokens: 5 });
});

test('AC4: responses without thinking tokens map exactly as before', () => {
  assert.deepEqual(
    usageFromGemini({ promptTokenCount: 7, candidatesTokenCount: 3 }),
    { inputTokens: 7, outputTokens: 3, cachedTokens: 0 },
  );
  assert.equal(usageFromGemini(null), null);
});

test('a header-less diff starting at "+++ b/…" still registers its file', () => {
  const r = changedLinesFromDiff('+++ b/h.js\n@@ -1 +1 @@\n-x\n+y\n');
  assert.deepEqual([...r['h.js']], [1]);
});

test('a hunk ending in a deletion does not swallow the next file header', () => {
  const diff = '+++ b/a.js\n@@ -1,2 +1,1 @@\n a\n-b\n+++ b/b.js\n@@ -1 +1 @@\n-x\n+y\n';
  const r = changedLinesFromDiff(diff);
  assert.deepEqual([...r['b.js']], [1]);
  assert.equal(r['a.js'].size, 0);
});

test('thinking tokens alone count as output when candidates are absent', () => {
  assert.equal(usageFromGemini({ promptTokenCount: 1, thoughtsTokenCount: 4 }).outputTokens, 4);
});
