/**
 * Tests for agreement grouping and winner selection logic.
 * Pure — no I/O, no network.
 *
 * Fixtures use hunks (issue #279), not full file content — a single
 * one-line hunk `{startLine: 1, endLine: 1, replacement: <text>}` stands in
 * for "this candidate's whole proposed edit" the same way the old fixtures
 * used a one-line `content` string.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeContent,
  changesetKey,
  groupByChangeset,
  selectWinner,
  isAllDivergent,
} from '../lib/agreement.mjs';

function hunk(replacement, startLine = 1, endLine = 1) {
  return [{ startLine, endLine, replacement }];
}

test('normalizeContent collapses whitespace', () => {
  assert.equal(normalizeContent('  hello   world  '), 'hello world');
  assert.equal(normalizeContent('a\n  b  \nc'), 'a\nb\nc');
});

test('normalizeContent treats equivalent whitespace as same', () => {
  const a = normalizeContent('if (x  ===  1)');
  const b = normalizeContent('if (x === 1)');
  assert.equal(a, b);
});

test('changesetKey is stable across ordering of changes', () => {
  const changes1 = [
    { file: 'b.mjs', hunks: hunk('const b = 2;') },
    { file: 'a.mjs', hunks: hunk('const a = 1;') },
  ];
  const changes2 = [
    { file: 'a.mjs', hunks: hunk('const a = 1;') },
    { file: 'b.mjs', hunks: hunk('const b = 2;') },
  ];
  assert.equal(changesetKey(changes1), changesetKey(changes2));
});

test('changesetKey differs for different replacement text', () => {
  const k1 = changesetKey([{ file: 'a.mjs', hunks: hunk('const a = 1;') }]);
  const k2 = changesetKey([{ file: 'a.mjs', hunks: hunk('const a = 2;') }]);
  assert.notEqual(k1, k2);
});

test('changesetKey differs for the same replacement text at a different line range', () => {
  // Same edit text, different location — must NOT be treated as agreement.
  const k1 = changesetKey([{ file: 'a.mjs', hunks: hunk('return x;', 10, 10) }]);
  const k2 = changesetKey([{ file: 'a.mjs', hunks: hunk('return x;', 20, 20) }]);
  assert.notEqual(k1, k2);
});

test('changesetKey is stable across hunk ordering within one file', () => {
  const k1 = changesetKey([{
    file: 'a.mjs',
    hunks: [
      { startLine: 20, endLine: 20, replacement: 'b' },
      { startLine: 10, endLine: 10, replacement: 'a' },
    ],
  }]);
  const k2 = changesetKey([{
    file: 'a.mjs',
    hunks: [
      { startLine: 10, endLine: 10, replacement: 'a' },
      { startLine: 20, endLine: 20, replacement: 'b' },
    ],
  }]);
  assert.equal(k1, k2);
});

test('groupByChangeset groups identical changesets together', () => {
  const sharedChanges = [{ file: 'a.mjs', hunks: hunk('const a = 1;') }];
  const candidates = [
    { index: 0, changes: sharedChanges, changedLines: 1, passed: true },
    { index: 1, changes: [{ file: 'a.mjs', hunks: hunk('const a = 2;') }], changedLines: 1, passed: true },
    { index: 2, changes: sharedChanges, changedLines: 1, passed: true },
  ];
  const groups = groupByChangeset(candidates);
  assert.equal(groups.size, 2);

  // Find the group with size 2.
  let bigGroup = null;
  for (const g of groups.values()) {
    if (g.length === 2) { bigGroup = g; break; }
  }
  assert.ok(bigGroup, 'should have a group of size 2');
  assert.deepEqual(
    bigGroup.map((c) => c.index).sort(),
    [0, 2]
  );
});

test('groupByChangeset treats whitespace-equivalent hunk replacement text as same group (issue #279)', () => {
  const candidates = [
    { index: 0, changes: [{ file: 'a.mjs', hunks: hunk('const a  =  1;') }], changedLines: 1, passed: true },
    { index: 1, changes: [{ file: 'a.mjs', hunks: hunk('const a = 1;') }], changedLines: 1, passed: true },
  ];
  const groups = groupByChangeset(candidates);
  assert.equal(groups.size, 1);
});

test('groupByChangeset treats whitespace-differing MULTI-LINE hunk replacements as the same group', () => {
  // Two candidates proposing the same semantic fix at the same line range,
  // one with extra indentation/trailing-space noise.
  const candidates = [
    {
      index: 0,
      changes: [{ file: 'a.mjs', hunks: [{ startLine: 5, endLine: 6, replacement: 'if (x) {\n  return 1;\n}' }] }],
      changedLines: 3,
      passed: true,
    },
    {
      index: 1,
      changes: [{ file: 'a.mjs', hunks: [{ startLine: 5, endLine: 6, replacement: 'if (x)   {\n    return  1;   \n}' }] }],
      changedLines: 3,
      passed: true,
    },
  ];
  const groups = groupByChangeset(candidates);
  assert.equal(groups.size, 1, 'whitespace-differing but semantically identical hunks must group together');
});

test('selectWinner picks the member of the largest group', () => {
  const candidates = [
    { index: 0, changes: [{ file: 'a.mjs', hunks: hunk('fix1') }], changedLines: 5, passed: true },
    { index: 1, changes: [{ file: 'a.mjs', hunks: hunk('fix2') }], changedLines: 3, passed: true },
    { index: 2, changes: [{ file: 'a.mjs', hunks: hunk('fix2') }], changedLines: 3, passed: true },
  ];
  const groups = groupByChangeset(candidates);
  const result = selectWinner(groups);
  // fix2 has 2 members — largest group.
  assert.equal(result.largestGroupSize, 2);
  // Both members have changedLines = 3, pick lowest index.
  assert.ok([1, 2].includes(result.winner.index));
});

test('selectWinner picks smallest changedLines within largest group', () => {
  const candidates = [
    { index: 0, changes: [{ file: 'a.mjs', hunks: hunk('same content') }], changedLines: 10, passed: true },
    { index: 1, changes: [{ file: 'a.mjs', hunks: hunk('same content') }], changedLines: 2, passed: true },
    { index: 2, changes: [{ file: 'a.mjs', hunks: hunk('same content') }], changedLines: 7, passed: true },
  ];
  const groups = groupByChangeset(candidates);
  const result = selectWinner(groups);
  assert.equal(result.winner.index, 1, 'should pick the candidate with fewest changed lines');
});

test('selectWinner returns null for empty groups', () => {
  const result = selectWinner(new Map());
  assert.equal(result, null);
});

test('isAllDivergent returns true when all groups are singletons and n>=3', () => {
  const candidates = [
    { index: 0, changes: [{ file: 'a.mjs', hunks: hunk('fix1') }], changedLines: 1, passed: true },
    { index: 1, changes: [{ file: 'a.mjs', hunks: hunk('fix2') }], changedLines: 1, passed: true },
    { index: 2, changes: [{ file: 'a.mjs', hunks: hunk('fix3') }], changedLines: 1, passed: true },
  ];
  const groups = groupByChangeset(candidates);
  assert.equal(isAllDivergent(groups, 3), true);
});

test('isAllDivergent returns false when n < 3', () => {
  const candidates = [
    { index: 0, changes: [{ file: 'a.mjs', hunks: hunk('fix1') }], changedLines: 1, passed: true },
    { index: 1, changes: [{ file: 'a.mjs', hunks: hunk('fix2') }], changedLines: 1, passed: true },
  ];
  const groups = groupByChangeset(candidates);
  assert.equal(isAllDivergent(groups, 2), false);
});

test('isAllDivergent returns false when any group has 2+ members', () => {
  const candidates = [
    { index: 0, changes: [{ file: 'a.mjs', hunks: hunk('shared') }], changedLines: 1, passed: true },
    { index: 1, changes: [{ file: 'a.mjs', hunks: hunk('shared') }], changedLines: 1, passed: true },
    { index: 2, changes: [{ file: 'a.mjs', hunks: hunk('unique') }], changedLines: 1, passed: true },
  ];
  const groups = groupByChangeset(candidates);
  assert.equal(isAllDivergent(groups, 3), false);
});
