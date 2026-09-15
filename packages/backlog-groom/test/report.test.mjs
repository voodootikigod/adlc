// report.test.mjs — AC20.
//
// Every run leads with its route distribution. A sweep that mechanically
// verified 4% of the backlog is still useful, but that number must sit next to
// the conclusions, or a thin run reads as a thorough one. Same honesty rule as
// `truncated`: an incomplete examination must never present as a complete one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coverageOf, renderReport } from '../lib/report.mjs';
import { emitGroomedSet } from '../lib/emit.mjs';

function rows(spec) {
  return spec.map(([number, route, verdict]) => ({ number, verified: { route, verdict } }));
}

test('AC20: coverage counts every route — mechanical, model, and not at all', () => {
  const c = coverageOf(rows([
    [1, 'mechanical', 'valid'],
    [2, 'mechanical', 'fixed'],
    [3, 'model', 'unverified'],
    [4, 'unverifiable', 'unverifiable'],
  ]));
  assert.equal(c.total, 4);
  assert.deepEqual(c.routes, { mechanical: 2, model: 1, unverifiable: 1 });
  assert.equal(c.mechanicalShare, 0.5);
});

test('AC20: the rendered report states all three counts before any conclusion', () => {
  const set = emitGroomedSet({ coverage: coverageOf(rows([[1, 'mechanical', 'valid'], [2, 'model', 'unverified']])) });
  const out = renderReport(set);
  const firstLines = out.split('\n').slice(0, 4).join('\n');
  assert.match(firstLines, /1 verified mechanically/);
  assert.match(firstLines, /1 routed to model/);
  assert.match(firstLines, /0 not verifiable/);
});

test('AC20: a thin run says so — the mechanical share is stated, not buried', () => {
  const spec = [[99, 'mechanical', 'valid']];
  for (let i = 0; i < 24; i += 1) spec.push([i, 'unverifiable', 'unverifiable']);
  const set = emitGroomedSet({ coverage: coverageOf(rows(spec)) });
  const out = renderReport(set);
  assert.match(out, /4\.0% mechanical/, 'the number an operator needs to judge the run must be in the text');
});

test('AC20: truncation is announced prominently, not implied', () => {
  const set = emitGroomedSet({ coverage: coverageOf(rows([[1, 'mechanical', 'valid']]), { truncated: 500 }), truncated: 500 });
  const out = renderReport(set);
  assert.match(out, /TRUNCATED at 500/);
  assert.match(out, /did not see the whole backlog/i, 'the consequence must be spelled out, not left to inference');
});

test('AC20: an untruncated run says nothing about truncation', () => {
  const set = emitGroomedSet({ coverage: coverageOf(rows([[1, 'mechanical', 'valid']])) });
  assert.doesNotMatch(renderReport(set), /TRUNCATED/);
});

test('AC20: verdict tallies are reported alongside the routes', () => {
  const set = emitGroomedSet({ coverage: coverageOf(rows([[1, 'mechanical', 'valid'], [2, 'mechanical', 'fixed'], [3, 'mechanical', 'moved']])) });
  const out = renderReport(set);
  assert.match(out, /1 valid/);
  assert.match(out, /1 fixed/);
  assert.match(out, /1 moved/);
});

test('AC20: the relation filter reports what judgment never saw', () => {
  const set = emitGroomedSet({
    coverage: coverageOf(rows([[1, 'mechanical', 'valid']])),
    relationFilter: { threshold: 0.2, pairsTotal: 100, pairsSurfaced: 4, pairsExcluded: 96, excludedRate: 0.96 },
  });
  const out = renderReport(set);
  assert.match(out, /96 excluded/);
  assert.match(out, /bound what this run could have found/i, 'the ceiling must be stated, since a filter miss is invisible otherwise');
});

test('AC20: an empty backlog reports zero without dividing by zero', () => {
  const c = coverageOf([]);
  assert.equal(c.total, 0);
  assert.equal(c.mechanicalShare, 0);
  assert.doesNotMatch(renderReport(emitGroomedSet({ coverage: c })), /NaN/);
});

test('AC20: a budget-dropped issue is NOT counted as mechanically verified', () => {
  // Its route records the intent, not the outcome. Counting intent would report
  // budget overflow as "verified mechanically" — a thin run reading as a
  // thorough one, which is the exact failure this coverage line prevents.
  const rows = [
    { number: 1, verified: { route: 'mechanical', verdict: 'valid' }, classified: { route: 'mechanical', references: [{ path: 'a' }] } },
    { number: 2, verified: { route: 'mechanical', verdict: 'unverifiable' }, classified: { route: 'mechanical', references: [], referencesTruncated: true } },
  ];
  const c = coverageOf(rows);
  assert.equal(c.routes.mechanical, 1, 'only the issue actually verified counts');
  assert.equal(c.routes.unverifiable, 1);
  assert.equal(c.mechanicalShare, 0.5);
});
