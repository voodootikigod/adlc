// rank.test.mjs — §3.5.
//
// The rank is what triggers a priority relabel, so its inputs have to be
// defensible individually. The existing label is ONE input among several, never
// the answer: its decay is the reason this package exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BANDS, bandOfLabel, rankIssue } from '../lib/rank.mjs';

const MAP = { high: 'P1-high', medium: 'P2-medium', low: 'P3-low' };

test('the bands are exactly these three, highest first', () => {
  assert.deepEqual([...BANDS], ['high', 'medium', 'low']);
});

test('bandOfLabel reads each band, and returns null for an unlabelled issue', () => {
  assert.equal(bandOfLabel(['P1-high'], MAP), 'high');
  assert.equal(bandOfLabel(['P2-medium'], MAP), 'medium');
  assert.equal(bandOfLabel(['P3-low'], MAP), 'low');
  assert.equal(bandOfLabel(['bug'], MAP), null);
});

test('a valid verdict outranks a fixed one, whatever the label says', () => {
  const live = rankIssue({ verdict: 'valid', labels: ['P3-low'], priorityMap: MAP });
  const done = rankIssue({ verdict: 'fixed', labels: ['P1-high'], priorityMap: MAP });
  assert.ok(live.score > done.score, 'the label cannot outvote what the code shows');
});

test('clusterSize defaults to 1 — an issue is not credited for a cluster it is not in', () => {
  // A default of 2 would silently give every issue a cluster bonus it never
  // earned, and the bonus is what tips a band.
  const alone = rankIssue({ verdict: 'valid', labels: [], priorityMap: MAP });
  assert.equal(alone.inputs.cluster, 0);
  const paired = rankIssue({ verdict: 'valid', labels: [], priorityMap: MAP, clusterSize: 2 });
  assert.ok(paired.inputs.cluster > 0, 'a real cluster does earn one');
});

test('frozen defaults to FALSE — an issue is not penalised for a freeze nobody declared', () => {
  const normal = rankIssue({ verdict: 'valid', labels: ['P1-high'], priorityMap: MAP });
  assert.equal(normal.inputs.frozen, 0);
  const frozen = rankIssue({ verdict: 'valid', labels: ['P1-high'], priorityMap: MAP, frozen: true });
  assert.ok(frozen.inputs.frozen < 0);
  assert.ok(frozen.score < normal.score, 'a frozen path cannot be actioned now, so it ranks lower');
});

test('the cluster bonus is capped so cluster size cannot outweigh the verdict', () => {
  const huge = rankIssue({ verdict: 'fixed', labels: [], priorityMap: MAP, clusterSize: 500 });
  const live = rankIssue({ verdict: 'valid', labels: [], priorityMap: MAP, clusterSize: 1 });
  assert.ok(live.score > huge.score, 'a big cluster of fixed issues must not outrank a live one');
});

test('an unlabelled issue sits between medium and low — absence is not evidence of unimportance', () => {
  const none = rankIssue({ verdict: 'valid', labels: [], priorityMap: MAP }).inputs.label;
  const medium = rankIssue({ verdict: 'valid', labels: ['P2-medium'], priorityMap: MAP }).inputs.label;
  const low = rankIssue({ verdict: 'valid', labels: ['P3-low'], priorityMap: MAP }).inputs.label;
  assert.ok(none < medium && none > low);
});

test('the score is clamped to 0..1 and the band follows it', () => {
  for (const args of [
    { verdict: 'valid', labels: ['P1-high'], clusterSize: 99 },
    { verdict: 'fixed', labels: [], frozen: true },
  ]) {
    const r = rankIssue({ ...args, priorityMap: MAP });
    assert.ok(r.score >= 0 && r.score <= 1, `score out of range: ${r.score}`);
    assert.ok(BANDS.includes(r.band));
  }
});
