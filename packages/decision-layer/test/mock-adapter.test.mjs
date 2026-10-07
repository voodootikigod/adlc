// The mock provider and the provider-neutral call path: the adapter contract's
// status rules (no answer is unknown, an unusable answer is error), bounded
// retries, and a mock that never derives answers from its input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNoNetwork } from './helpers/no-network.mjs';
import { MOCK_DEFAULT_RESPONSE, createMockProvider } from '../lib/mock-provider.mjs';
import { MAX_RETRIES, evaluateDecision } from '../lib/provider.mjs';
import { reduce } from '../lib/reducer.mjs';

installNoNetwork();

const PACK = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'packs', 'change-risk-v1', 'pack.json'), 'utf8'));
const INPUT = { extensionCounts: { mjs: 1 }, linesAdded: 1, linesDeleted: 0, filesChanged: 1, ticketCategory: 'none', declaredRailCount: 'none' };

const run = (responseText, input = INPUT) => evaluateDecision({
  provider: createMockProvider({ responseText }),
  model: 'mock-1',
  pack: PACK,
  sanitizedInput: input,
  retryDelayMs: 0,
});
const body = (answers, extra = {}) => JSON.stringify({ answers, ...extra });
const ok = [
  { id: 'risk', value: 'low', probability: 0.9 },
  { id: 'needs-deeper-interrogation', value: 'no', probability: 0.8, confidence: 0.6 },
];

test('without a scripted response the mock answers medium/no at 0.5, which reduces to unknown', async () => {
  const result = await run(undefined);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.answers, [
    { id: 'risk', kind: 'Choice', value: 'medium', probability: 0.5 },
    { id: 'needs-deeper-interrogation', kind: 'Noul', value: 'no', probability: 0.5 },
  ]);
  assert.equal(reduce({ ...result, pack: PACK }).outcome, 'unknown');
  assert.deepEqual(JSON.parse(MOCK_DEFAULT_RESPONSE).answers.map((a) => [a.id, a.value, a.probability]), [
    ['risk', 'medium', 0.5],
    ['needs-deeper-interrogation', 'no', 0.5],
  ]);
});

test('a scripted response is normalized into pack order with the question kinds', async () => {
  const result = await run(body([...ok].reverse(), { resolvedModel: 'mock-1.0.3', usage: { calls: 1 } }));
  assert.deepEqual(result, {
    status: 'ok',
    answers: [
      { id: 'risk', kind: 'Choice', value: 'low', probability: 0.9 },
      { id: 'needs-deeper-interrogation', kind: 'Noul', value: 'no', probability: 0.8, confidence: 0.6 },
    ],
    requestedModel: 'mock-1',
    resolvedModel: 'mock-1.0.3',
    errorClass: null,
    usage: { calls: 1 },
    attemptCount: 1,
    latencyMs: result.latencyMs,
  });
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
});

test('the resolved model defaults to the requested one', async () => {
  assert.equal((await run(body(ok))).resolvedModel, 'mock-1');
});

test('the mock never derives answers from its input', async () => {
  const other = { ...INPUT, linesAdded: 99999, ticketCategory: 'security', declaredRailCount: 40 };
  assert.deepEqual((await run(undefined, other)).answers, (await run(undefined)).answers);
  assert.deepEqual((await run(body(ok), other)).answers, (await run(body(ok))).answers);
});

test('a timeout is unknown after one attempt: timeouts are not retried', async () => {
  const result = await run(JSON.stringify({ simulate: 'timeout' }));
  assert.equal(result.status, 'unknown');
  assert.equal(result.errorClass, 'timeout');
  assert.equal(result.attemptCount, 1);
  assert.deepEqual(result.answers, []);
});

for (const failure of ['rate-limit', 'network']) {
  test(`${failure} is retried at most ${MAX_RETRIES} times, then unknown`, async () => {
    const result = await run(JSON.stringify({ simulate: failure }));
    assert.equal(result.status, 'unknown');
    assert.equal(result.errorClass, failure);
    assert.equal(result.attemptCount, 1 + MAX_RETRIES);
  });
}

test('MAX_RETRIES is 2', () => {
  assert.equal(MAX_RETRIES, 2);
});

test('a retried failure that then answers is ok, with the attempts counted', async () => {
  const outcomes = [{ failure: 'rate-limit' }, { failure: 'network' }, { body: JSON.parse(body(ok)) }];
  const provider = { name: 'scripted', call: async () => outcomes.shift() };
  const result = await evaluateDecision({ provider, model: 'm', pack: PACK, sanitizedInput: INPUT, retryDelayMs: 0 });
  assert.equal(result.status, 'ok');
  assert.equal(result.attemptCount, 3);
});

test('retries wait retryDelayMs between attempts', async () => {
  const delays = [];
  const provider = { name: 'scripted', call: async () => ({ failure: 'network' }) };
  await evaluateDecision({ provider, model: 'm', pack: PACK, sanitizedInput: INPUT, retryDelayMs: 5, sleep: async (ms) => { delays.push(ms); } });
  assert.deepEqual(delays, [5, 5]);
});

test('the provider receives the model, the pack questions and the sanitized input', async () => {
  let seen;
  const provider = { name: 'spy', call: async (request) => { seen = request; return { body: JSON.parse(body(ok)) }; } };
  await evaluateDecision({ provider, model: 'm-7', pack: PACK, sanitizedInput: INPUT, retryDelayMs: 0 });
  assert.equal(seen.model, 'm-7');
  assert.equal(seen.packId, 'change-risk-v1');
  assert.deepEqual(seen.questions.map((q) => q.id), ['risk', 'needs-deeper-interrogation']);
  assert.deepEqual(seen.input, INPUT);
});

test('a provider that throws is recorded as an unknown network failure, not a crash', async () => {
  const provider = { name: 'broken', call: async () => { throw new Error('socket hang up'); } };
  const result = await evaluateDecision({ provider, model: 'm', pack: PACK, sanitizedInput: INPUT, retryDelayMs: 0 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.errorClass, 'network');
});

const ERROR_CASES = [
  ['text that is not JSON', '{oops', 'malformed-response'],
  ['a bare array', '[]', 'malformed-response'],
  ['an unexpected top-level key', body(ok, { note: 'hi' }), 'malformed-response'],
  ['an unknown simulate value', JSON.stringify({ simulate: 'meltdown' }), 'malformed-response'],
  ['a missing answer', body(ok.slice(0, 1)), 'malformed-response'],
  ['a duplicate answer', body([ok[0], ok[0]]), 'malformed-response'],
  ['an extra answer', body([...ok, { id: 'mood', value: 'good' }]), 'malformed-response'],
  ['a wrong kind', body([{ ...ok[0], kind: 'Score' }, ok[1]]), 'malformed-response'],
  ['an unexpected answer key', body([{ ...ok[0], reasoning: 'x' }, ok[1]]), 'malformed-response'],
  ['a probability above 1', body([{ ...ok[0], probability: 1.2 }, ok[1]]), 'malformed-response'],
  ['a non-numeric confidence', body([{ ...ok[0], confidence: 'high' }, ok[1]]), 'malformed-response'],
  ['a non-string resolved model', body(ok, { resolvedModel: 7 }), 'malformed-response'],
  ['usage that is not an object', body(ok, { usage: 'lots' }), 'malformed-response'],
  ['an answers field that is not a list', JSON.stringify({ answers: {} }), 'malformed-response'],
  ['an answer that is not an object', body(['low', ok[1]]), 'malformed-response'],
  ['an out-of-domain Choice', body([{ ...ok[0], value: 'extreme' }, ok[1]]), 'out-of-domain'],
  ['an out-of-domain Noul', body([ok[0], { ...ok[1], value: 'maybe' }]), 'out-of-domain'],
];

for (const [name, text, errorClass] of ERROR_CASES) {
  test(`an answer that arrived but is unusable is error: ${name}`, async () => {
    const result = await run(text);
    assert.equal(result.status, 'error');
    assert.equal(result.errorClass, errorClass);
    assert.deepEqual(result.answers, []);
    assert.equal(result.attemptCount, 1);
  });
}

test('Score answers must be numbers within the domain', async () => {
  const pack = { ...PACK, questions: [{ ...PACK.questions[0], kind: 'Score', domain: { min: 0, max: 1 } }] };
  const score = (value) => ({ name: 's', call: async () => ({ body: { answers: [{ id: 'risk', value }] } }) });
  const call = (value) => evaluateDecision({ provider: score(value), model: 'm', pack, sanitizedInput: INPUT, retryDelayMs: 0 });
  assert.equal((await call(0.4)).status, 'ok');
  assert.equal((await call(1.5)).errorClass, 'out-of-domain');
  assert.equal((await call('0.4')).errorClass, 'out-of-domain');
});
