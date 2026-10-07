// The reducer (AC7): total over every answer/status combination of
// change-risk-v1, never `allow` for an unknown or error status, and `wouldAct`
// from the spec's phase-action table for each phase the pack describes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNoNetwork } from './helpers/no-network.mjs';
import { PHASE_ACTIONS, reduce } from '../lib/reducer.mjs';

installNoNetwork();

const PACK = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'packs', 'change-risk-v1', 'pack.json'), 'utf8'));

const answers = (risk, needs, pRisk, pNeeds) => [
  { id: 'risk', kind: 'Choice', value: risk, ...(pRisk === undefined ? {} : { probability: pRisk }) },
  { id: 'needs-deeper-interrogation', kind: 'Noul', value: needs, ...(pNeeds === undefined ? {} : { probability: pNeeds }) },
];

/** The spec's aggregation for change-risk-v1, written out independently of the reducer. */
function expected(status, risk, needs, pRisk, pNeeds) {
  if (status !== 'ok') return 'unknown';
  if (risk === 'high' || needs === 'yes') return 'escalate';
  if (risk === 'low' && needs === 'no' && pRisk >= 0.7 && pNeeds >= 0.7) return 'allow';
  return 'unknown';
}

test('the phase-action table is the spec table', () => {
  assert.deepEqual(PHASE_ACTIONS, {
    P0: { allow: 'keep-deterministic-triage', escalate: 'recommend-deeper-interrogation', unknown: 'record-inconclusive' },
    D1: { allow: 'keep-deterministic-assignment', escalate: 'recommend-one-tier-up', unknown: 'keep-deterministic-assignment' },
  });
});

test('total over every status, answer and probability combination', () => {
  const probabilities = [undefined, 0, 0.69, 0.7, 1];
  let cases = 0;
  for (const status of ['ok', 'unknown', 'error']) {
    for (const risk of ['low', 'medium', 'high']) {
      for (const needs of ['yes', 'no']) {
        for (const pRisk of probabilities) {
          for (const pNeeds of probabilities) {
            const result = reduce({ status, answers: answers(risk, needs, pRisk, pNeeds), pack: PACK });
            const want = expected(status, risk, needs, pRisk, pNeeds);
            assert.equal(result.outcome, want, JSON.stringify({ status, risk, needs, pRisk, pNeeds }));
            assert.deepEqual(result.wouldAct, { P0: PHASE_ACTIONS.P0[want], D1: PHASE_ACTIONS.D1[want] });
            cases += 1;
          }
        }
      }
    }
  }
  assert.equal(cases, 3 * 3 * 2 * 5 * 5);
});

test('unknown and error never reduce to allow, even with no answers at all', () => {
  for (const status of ['unknown', 'error']) {
    assert.equal(reduce({ status, answers: answers('low', 'no', 1, 1), pack: PACK }).outcome, 'unknown');
    assert.equal(reduce({ status, answers: [], pack: PACK }).outcome, 'unknown');
  }
});

test('an ok status with a missing answer is unknown, not allow', () => {
  assert.equal(reduce({ status: 'ok', answers: answers('low', 'no', 1, 1).slice(0, 1), pack: PACK }).outcome, 'unknown');
});

test('a pack with no allow conditions can never allow', () => {
  const pack = { ...PACK, aggregation: { escalateIf: PACK.aggregation.escalateIf, allowIf: [] } };
  assert.equal(reduce({ status: 'ok', answers: answers('low', 'no', 1, 1), pack }).outcome, 'unknown');
});

test('Score conditions compare against atLeast and atMost', () => {
  const pack = {
    ...PACK,
    questions: [{ ...PACK.questions[0], kind: 'Score', domain: { min: 0, max: 1 }, phases: ['D1'] }],
    aggregation: {
      escalateIf: [{ question: 'risk', atLeast: 0.8 }],
      allowIf: [{ question: 'risk', atMost: 0.2, minProbability: 0.5 }],
    },
  };
  const score = (value, probability) => [{ id: 'risk', kind: 'Score', value, probability }];
  assert.equal(reduce({ status: 'ok', answers: score(0.8, 0), pack }).outcome, 'escalate');
  assert.equal(reduce({ status: 'ok', answers: score(0.79, 0), pack }).outcome, 'unknown');
  assert.equal(reduce({ status: 'ok', answers: score(0.2, 0.5), pack }).outcome, 'allow');
  assert.equal(reduce({ status: 'ok', answers: score(0.21, 0.5), pack }).outcome, 'unknown');
  assert.equal(reduce({ status: 'ok', answers: score(0.2, 0.49), pack }).outcome, 'unknown');
  assert.deepEqual(reduce({ status: 'ok', answers: score(0.2, 0.5), pack }).wouldAct, { D1: 'keep-deterministic-assignment' });
});

test('reduce is pure: it does not mutate its arguments', () => {
  const input = answers('high', 'no', 0.9, 0.9);
  const before = structuredClone({ input, PACK });
  reduce({ status: 'ok', answers: input, pack: PACK });
  assert.deepEqual({ input, PACK }, before);
});
