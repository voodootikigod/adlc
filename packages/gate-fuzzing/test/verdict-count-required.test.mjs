// computeVerdict certifies a clean run only when it is told how many candidates
// were classified. A missing or malformed count is unverifiable, so it fails
// closed (exit 2, inconclusive) — and --allow-empty, which forgives a verified
// zero, does not forgive an unknown count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVerdict } from '../lib/verdict.mjs';

const cleanRun = {
  defeats: [],
  stoppedBy: 'dry',
  inconclusiveRounds: 0,
  rounds: 3,
  strictBudget: false,
  failOnBehavioral: false,
  independenceConfigured: true,
};

const INCONCLUSIVE = { exitCode: 2, summary: 'inconclusive', inconclusive: true };

function pick(result) {
  return { exitCode: result.exitCode, summary: result.summary, inconclusive: result.inconclusive };
}

test('an omitted candidatesClassified fails closed instead of reporting clean', () => {
  assert.deepEqual(pick(computeVerdict(cleanRun)), INCONCLUSIVE);
});

for (const bad of [null, -1, 1.5, Number.NaN, '3', Infinity]) {
  test(`a malformed candidatesClassified (${String(bad)}) fails closed`, () => {
    assert.deepEqual(pick(computeVerdict({ ...cleanRun, candidatesClassified: bad })), INCONCLUSIVE);
  });
}

test('--allow-empty does not forgive an unknown count', () => {
  assert.deepEqual(pick(computeVerdict({ ...cleanRun, allowEmpty: true })), INCONCLUSIVE);
});

test('only candidatesClassified is read as the count', () => {
  for (const alias of ['totalCandidates', 'candidatesGenerated', 'candidatesCount']) {
    assert.deepEqual(pick(computeVerdict({ ...cleanRun, [alias]: 5 })), INCONCLUSIVE, alias);
  }
});

test('a positive integer count with a dry streak is still clean', () => {
  assert.deepEqual(pick(computeVerdict({ ...cleanRun, candidatesClassified: 1 })),
    { exitCode: 0, summary: 'clean', inconclusive: false });
});

test('a contract-derived defeat is reported as gate-defeated whatever the count says', () => {
  const defeat = { witnessSource: 'contract-derived' };
  const result = computeVerdict({ ...cleanRun, defeats: [defeat] });
  assert.deepEqual(pick(result), { exitCode: 2, summary: 'gate-defeated', inconclusive: false });
  assert.deepEqual(result.defeats, [defeat]);
});
