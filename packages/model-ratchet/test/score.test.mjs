// test/score.test.mjs — Tests for score.mjs (hot-score computation).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeScores, topN, charterLine } from '../lib/score.mjs';

describe('computeScores', () => {
  it('computes score as churn × (1 + inDegree)', () => {
    const churnMap = { 'a.mjs': 10, 'b.mjs': 5, 'c.mjs': 3 };
    const inDegMap = { 'a.mjs': 0, 'b.mjs': 2, 'c.mjs': 4 };
    const files = ['a.mjs', 'b.mjs', 'c.mjs'];

    const rows = computeScores(churnMap, inDegMap, files);
    const byFile = Object.fromEntries(rows.map(r => [r.file, r]));

    // a: 10 * (1 + 0) = 10
    assert.equal(byFile['a.mjs'].score, 10);
    // b: 5 * (1 + 2) = 15
    assert.equal(byFile['b.mjs'].score, 15);
    // c: 3 * (1 + 4) = 15
    assert.equal(byFile['c.mjs'].score, 15);
  });

  it('sorts descending by score', () => {
    const churnMap = { 'a.mjs': 2, 'b.mjs': 10, 'c.mjs': 1 };
    const inDegMap = { 'a.mjs': 0, 'b.mjs': 0, 'c.mjs': 0 };
    const files = ['a.mjs', 'b.mjs', 'c.mjs'];

    const rows = computeScores(churnMap, inDegMap, files);
    assert.equal(rows[0].file, 'b.mjs');
    assert.equal(rows[1].file, 'a.mjs');
    assert.equal(rows[2].file, 'c.mjs');
  });

  it('uses zero for files not in churn map', () => {
    const churnMap = {};
    const inDegMap = { 'a.mjs': 3 };
    const files = ['a.mjs'];

    const rows = computeScores(churnMap, inDegMap, files);
    // churn=0 → score = 0 * (1+3) = 0
    assert.equal(rows[0].score, 0);
    assert.equal(rows[0].churn, 0);
    assert.equal(rows[0].inDegree, 3);
  });

  it('uses zero for files not in inDegree map', () => {
    const churnMap = { 'a.mjs': 7 };
    const inDegMap = {};
    const files = ['a.mjs'];

    const rows = computeScores(churnMap, inDegMap, files);
    // inDegree=0 → score = 7 * (1+0) = 7
    assert.equal(rows[0].score, 7);
    assert.equal(rows[0].inDegree, 0);
  });

  it('returns all fields', () => {
    const rows = computeScores({ 'x.ts': 4 }, { 'x.ts': 1 }, ['x.ts']);
    assert.equal(rows[0].file, 'x.ts');
    assert.equal(rows[0].churn, 4);
    assert.equal(rows[0].inDegree, 1);
    assert.equal(rows[0].score, 8); // 4 * (1+1)
  });

  it('is deterministic on tie: sorts by filename', () => {
    // b and c both have score 5
    const rows = computeScores(
      { 'b.mjs': 5, 'c.mjs': 5 },
      { 'b.mjs': 0, 'c.mjs': 0 },
      ['b.mjs', 'c.mjs']
    );
    assert.equal(rows[0].file, 'b.mjs');
    assert.equal(rows[1].file, 'c.mjs');
  });
});

describe('topN', () => {
  it('returns first n rows', () => {
    const rows = [{ file: 'a' }, { file: 'b' }, { file: 'c' }, { file: 'd' }];
    assert.deepEqual(topN(rows, 2), [{ file: 'a' }, { file: 'b' }]);
  });

  it('returns all rows when n >= length', () => {
    const rows = [{ file: 'a' }, { file: 'b' }];
    assert.deepEqual(topN(rows, 10), rows);
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(topN([], 5), []);
  });
});

describe('charterLine', () => {
  it('formats charter line correctly', () => {
    const row = { file: 'src/auth.mjs', churn: 42, inDegree: 7, score: 336 };
    const line = charterLine(row);
    assert.equal(
      line,
      'Refute correctness of src/auth.mjs — hotspot: changed 42 times, imported by 7 files'
    );
  });

  it('handles zero inDegree', () => {
    const row = { file: 'lib/util.ts', churn: 3, inDegree: 0, score: 3 };
    const line = charterLine(row);
    assert.ok(line.includes('imported by 0 files'));
  });
});
