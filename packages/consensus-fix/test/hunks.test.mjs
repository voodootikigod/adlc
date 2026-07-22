/**
 * Tests for hunks.mjs — apply and measure structured line-range edits.
 * Pure — no I/O, no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunks, hunkChangedLines, totalHunkChangedLines } from '../lib/hunks.mjs';

const FILE = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n');

test('applyHunks replaces a single line', () => {
  const result = applyHunks(FILE, [{ startLine: 3, endLine: 3, replacement: 'REPLACED' }]);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'line 1\nline 2\nREPLACED\nline 4\nline 5');
});

test('applyHunks replaces a multi-line range with a different number of lines', () => {
  const result = applyHunks(FILE, [{ startLine: 2, endLine: 4, replacement: 'X\nY' }]);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'line 1\nX\nY\nline 5');
});

test('applyHunks deletes a range (empty replacement)', () => {
  const result = applyHunks(FILE, [{ startLine: 2, endLine: 3, replacement: '' }]);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'line 1\nline 4\nline 5');
});

test('applyHunks inserts without deleting (endLine = startLine - 1)', () => {
  const result = applyHunks(FILE, [{ startLine: 3, endLine: 2, replacement: 'INSERTED' }]);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'line 1\nline 2\nINSERTED\nline 3\nline 4\nline 5');
});

test('applyHunks can insert at the very end of the file', () => {
  const result = applyHunks(FILE, [{ startLine: 6, endLine: 5, replacement: 'APPENDED' }]);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'line 1\nline 2\nline 3\nline 4\nline 5\nAPPENDED');
});

test('applyHunks applies multiple non-overlapping hunks in one call', () => {
  const result = applyHunks(FILE, [
    { startLine: 1, endLine: 1, replacement: 'FIRST' },
    { startLine: 5, endLine: 5, replacement: 'LAST' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'FIRST\nline 2\nline 3\nline 4\nLAST');
});

test('applyHunks with multiple hunks does not let an earlier edit shift a later hunk\'s line numbers', () => {
  // Insert 3 new lines at line 2, then edit what was originally line 4 —
  // if hunks were applied in array order without adjusting for the shift,
  // this would corrupt the wrong line.
  const result = applyHunks(FILE, [
    { startLine: 2, endLine: 1, replacement: 'A\nB\nC' }, // insert before original line 2
    { startLine: 4, endLine: 4, replacement: 'CHANGED-4' }, // still refers to ORIGINAL line 4
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'line 1\nA\nB\nC\nline 2\nline 3\nCHANGED-4\nline 5');
});

test('applyHunks rejects an empty hunks array', () => {
  const result = applyHunks(FILE, []);
  assert.equal(result.ok, false);
  assert.match(result.error, /non-empty array/);
});

test('applyHunks rejects a non-array hunks argument', () => {
  const result = applyHunks(FILE, null);
  assert.equal(result.ok, false);
});

test('applyHunks rejects a null entry within an otherwise well-formed hunks array', () => {
  // typeof null === 'object' in JS — a hunk-shape check that only tests
  // `typeof hunk !== 'object'` (without also checking truthiness) would
  // silently accept null here and crash on hunk.startLine instead.
  const result = applyHunks(FILE, [null]);
  assert.equal(result.ok, false);
});

test('applyHunks rejects a non-object (e.g. string) entry within the hunks array', () => {
  const result = applyHunks(FILE, ['not a hunk']);
  assert.equal(result.ok, false);
});

test('applyHunks rejects startLine < 1', () => {
  const result = applyHunks(FILE, [{ startLine: 0, endLine: 1, replacement: 'x' }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /startLine must be >= 1/);
});

test('applyHunks rejects endLine beyond the file length', () => {
  const result = applyHunks(FILE, [{ startLine: 1, endLine: 99, replacement: 'x' }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeds file length/);
});

test('applyHunks rejects endLine < startLine - 1 (an invalid negative-length range)', () => {
  const result = applyHunks(FILE, [{ startLine: 3, endLine: 1, replacement: 'x' }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /endLine .* must be >= startLine - 1/);
});

test('applyHunks rejects non-integer startLine/endLine', () => {
  const result = applyHunks(FILE, [{ startLine: 1.5, endLine: 2, replacement: 'x' }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /must be integers/);
});

test('applyHunks rejects a non-string replacement', () => {
  const result = applyHunks(FILE, [{ startLine: 1, endLine: 1, replacement: 42 }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /replacement must be a string/);
});

test('applyHunks rejects overlapping hunks', () => {
  const result = applyHunks(FILE, [
    { startLine: 1, endLine: 3, replacement: 'a' },
    { startLine: 2, endLine: 4, replacement: 'b' },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error, /overlap/);
});

test('applyHunks accepts adjacent (non-overlapping, touching) hunks', () => {
  const result = applyHunks(FILE, [
    { startLine: 1, endLine: 2, replacement: 'a' },
    { startLine: 3, endLine: 5, replacement: 'b' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'a\nb');
});

test('applyHunks validates ALL hunks before applying any (a bad hunk never partially mutates)', () => {
  const result = applyHunks(FILE, [
    { startLine: 1, endLine: 1, replacement: 'GOOD' },
    { startLine: 1, endLine: 999, replacement: 'BAD' }, // out of bounds AND overlaps hunk 1
  ]);
  assert.equal(result.ok, false);
});

// ── hunkChangedLines / totalHunkChangedLines ────────────────────────────────

test('hunkChangedLines: same-size replacement counts its own span', () => {
  assert.equal(hunkChangedLines({ startLine: 5, endLine: 5, replacement: 'x' }), 1);
  assert.equal(hunkChangedLines({ startLine: 5, endLine: 7, replacement: 'a\nb\nc' }), 3);
});

test('hunkChangedLines: pure deletion counts the removed span', () => {
  assert.equal(hunkChangedLines({ startLine: 5, endLine: 8, replacement: '' }), 4);
});

test('hunkChangedLines: pure insertion counts the inserted span', () => {
  assert.equal(hunkChangedLines({ startLine: 5, endLine: 4, replacement: 'a\nb\nc' }), 3);
});

test('hunkChangedLines: takes the LARGER of removed/inserted spans', () => {
  assert.equal(hunkChangedLines({ startLine: 1, endLine: 10, replacement: 'one line' }), 10);
  assert.equal(hunkChangedLines({ startLine: 1, endLine: 1, replacement: 'a\nb\nc\nd' }), 4);
});

test('totalHunkChangedLines sums across multiple hunks and multiple files', () => {
  const changes = [
    { file: 'a.mjs', hunks: [{ startLine: 1, endLine: 1, replacement: 'x' }, { startLine: 5, endLine: 6, replacement: 'y\nz' }] },
    { file: 'b.mjs', hunks: [{ startLine: 1, endLine: 3, replacement: '' }] },
  ];
  // a.mjs: 1 + 2 = 3; b.mjs: 3. Total 6.
  assert.equal(totalHunkChangedLines(changes), 6);
});

test('totalHunkChangedLines returns 0 for an empty changeset', () => {
  assert.equal(totalHunkChangedLines([]), 0);
});
