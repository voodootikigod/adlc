// Tests for lib/scoring.mjs — pure functions, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScore, renderReport, renderRouteConflict } from '../lib/scoring.mjs';

test('computeScore: no agreements no divergences → 0', () => {
  assert.equal(computeScore(0, 0), 0);
});

test('computeScore: all agreements → 0', () => {
  assert.equal(computeScore(0, 5), 0);
});

test('computeScore: all divergences → 1', () => {
  assert.equal(computeScore(5, 0), 1);
});

test('computeScore: half and half → 0.5', () => {
  assert.equal(computeScore(3, 3), 0.5);
});

test('computeScore: rounds to 2 dp', () => {
  // 1 / (1+3) = 0.25 exactly
  assert.equal(computeScore(1, 3), 0.25);
});

test('computeScore: 2 divergences, 3 agreements → 0.4', () => {
  assert.equal(computeScore(2, 3), 0.4);
});

test('computeScore: rounds properly - 1/(1+2) = 0.33', () => {
  assert.equal(computeScore(1, 2), 0.33);
});

test('renderReport: agreements appear as bullets', () => {
  const report = renderReport({
    agreements: ['Users must be authenticated', 'Returns JSON'],
    divergences: [],
    score: 0,
    threshold: 0.25,
  });
  assert.ok(report.includes('## Agreement set (draft spec)'));
  assert.ok(report.includes('- Users must be authenticated'));
  assert.ok(report.includes('- Returns JSON'));
  assert.ok(report.includes('Ambiguity score:'));
  assert.ok(report.includes('PASSES'));
});

test('renderReport: divergences appear as multiple-choice questions', () => {
  const report = renderReport({
    agreements: ['Must paginate'],
    divergences: [
      {
        point: 'How should errors be returned?',
        options: [
          { label: 'A', reading: 'HTTP 4xx with error body' },
          { label: 'B', reading: 'Always 200 with error field' },
        ],
      },
    ],
    score: 0.5,
    threshold: 0.25,
  });
  assert.ok(report.includes('## Divergences — answer these'));
  assert.ok(report.includes('Q1: How should errors be returned?'));
  assert.ok(report.includes('A) HTTP 4xx with error body'));
  assert.ok(report.includes('B) Always 200 with error field'));
  assert.ok(report.includes('0.50'));
  assert.ok(report.includes('FAILS'));
});

test('renderReport: gate PASSES when score <= threshold', () => {
  const report = renderReport({ agreements: ['a', 'b', 'c'], divergences: [], score: 0.0, threshold: 0.25 });
  assert.ok(report.includes('PASSES'));
  assert.ok(!report.includes('FAILS'));
});

test('renderReport: gate FAILS when score > threshold', () => {
  const report = renderReport({ agreements: ['a'], divergences: [{ point: 'x', options: [{ label: 'A', reading: 'y' }, { label: 'B', reading: 'z' }] }], score: 0.5, threshold: 0.25 });
  assert.ok(report.includes('FAILS'));
  assert.ok(!report.includes('PASSES'));
});

test('renderReport: no agreements shows fallback text', () => {
  const report = renderReport({ agreements: [], divergences: [], score: 0, threshold: 0.25 });
  assert.ok(report.includes('no clear agreements'));
});

test('renderReport: no divergences shows fallback text', () => {
  const report = renderReport({ agreements: ['something'], divergences: [], score: 0, threshold: 0.25 });
  assert.ok(report.includes('none — all readings converged'));
});

test('renderRouteConflict: renders question and labelled variants', () => {
  const output = renderRouteConflict('Which database?', ['PostgreSQL', 'MySQL', 'SQLite']);
  assert.ok(output.includes('## Route conflict'));
  assert.ok(output.includes('Which database?'));
  assert.ok(output.includes('A) PostgreSQL'));
  assert.ok(output.includes('B) MySQL'));
  assert.ok(output.includes('C) SQLite'));
});
