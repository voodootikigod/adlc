/**
 * Tests for agreement grouping and winner selection logic.
 * Pure — no I/O, no network.
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
    { file: 'b.mjs', content: 'const b = 2;' },
    { file: 'a.mjs', content: 'const a = 1;' },
  ];
  const changes2 = [
    { file: 'a.mjs', content: 'const a = 1;' },
    { file: 'b.mjs', content: 'const b = 2;' },
  ];
  assert.equal(changesetKey(changes1), changesetKey(changes2));
});

test('changesetKey differs for different content', () => {
  const k1 = changesetKey([{ file: 'a.mjs', content: 'const a = 1;' }]);
  const k2 = changesetKey([{ file: 'a.mjs', content: 'const a = 2;' }]);
  assert.notEqual(k1, k2);
});

test('groupByChangeset groups identical changesets together', () => {
  const sharedChanges = [{ file: 'a.mjs', content: 'const a = 1;' }];
  const candidates = [
    { index: 0, changes: sharedChanges, changedLines: 1, passed: true },
    { index: 1, changes: [{ file: 'a.mjs', content: 'const a = 2;' }], changedLines: 1, passed: true },
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

test('groupByChangeset treats whitespace-equivalent content as same group', () => {
  const candidates = [
    { index: 0, changes: [{ file: 'a.mjs', content: 'const a  =  1;' }], changedLines: 1, passed: true },
    { index: 1, changes: [{ file: 'a.mjs', content: 'const a = 1;' }], changedLines: 1, passed: true },
  ];
  const groups = groupByChangeset(candidates);
  assert.equal(groups.size, 1);
});

test('selectWinner picks the member of the largest group', () => {
  const candidates = [
    { index: 0, changes: [{ file: 'a.mjs', content: 'fix1' }], changedLines: 5, passed: true },
    { index: 1, changes: [{ file: 'a.mjs', content: 'fix2' }], changedLines: 3, passed: true },
    { index: 2, changes: [{ file: 'a.mjs', content: 'fix2' }], changedLines: 3, passed: true },
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
    { index: 0, changes: [{ file: 'a.mjs', content: 'same content' }], changedLines: 10, passed: true },
    { index: 1, changes: [{ file: 'a.mjs', content: 'same content' }], changedLines: 2, passed: true },
    { index: 2, changes: [{ file: 'a.mjs', content: 'same content' }], changedLines: 7, passed: true },
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
    { index: 0, changes: [{ file: 'a.mjs', content: 'fix1' }], changedLines: 1, passed: true },
    { index: 1, changes: [{ file: 'a.mjs', content: 'fix2' }], changedLines: 1, passed: true },
    { index: 2, changes: [{ file: 'a.mjs', content: 'fix3' }], changedLines: 1, passed: true },
  ];
  const groups = groupByChangeset(candidates);
  assert.equal(isAllDivergent(groups, 3), true);
});

test('isAllDivergent returns false when n < 3', () => {
  const candidates = [
    { index: 0, changes: [{ file: 'a.mjs', content: 'fix1' }], changedLines: 1, passed: true },
    { index: 1, changes: [{ file: 'a.mjs', content: 'fix2' }], changedLines: 1, passed: true },
  ];
  const groups = groupByChangeset(candidates);
  assert.equal(isAllDivergent(groups, 2), false);
});

test('isAllDivergent returns false when any group has 2+ members', () => {
  const candidates = [
    { index: 0, changes: [{ file: 'a.mjs', content: 'shared' }], changedLines: 1, passed: true },
    { index: 1, changes: [{ file: 'a.mjs', content: 'shared' }], changedLines: 1, passed: true },
    { index: 2, changes: [{ file: 'a.mjs', content: 'unique' }], changedLines: 1, passed: true },
  ];
  const groups = groupByChangeset(candidates);
  assert.equal(isAllDivergent(groups, 3), false);
});
