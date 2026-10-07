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
import { PackError, packHash } from '../lib/pack.mjs';
import { SanitizationError } from '../lib/sanitizer.mjs';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../lib/canonical.mjs';
import { DEFAULT_TIMEOUT_MS, MAX_RETRIES, evaluateDecision, isPinnedModel } from '../lib/provider.mjs';
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
  const result = await run(body([...ok].reverse(), { resolvedModel: 'mock-1.0.3', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }));
  assert.deepEqual(result, {
    status: 'ok',
    answers: [
      { id: 'risk', kind: 'Choice', value: 'low', probability: 0.9 },
      { id: 'needs-deeper-interrogation', kind: 'Noul', value: 'no', probability: 0.8, confidence: 0.6 },
    ],
    requestedModel: 'mock-1',
    resolvedModel: 'mock-1.0.3',
    packHash: packHash(PACK),
    errorClass: null,
    usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    attemptCount: 1,
    latencyMs: result.latencyMs,
  });
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
});

test('a reply that reports no resolved model records null, not the requested model', async () => {
  assert.equal((await run(body(ok))).resolvedModel, null);
  assert.equal((await run(undefined)).resolvedModel, null);
});

test('a failure with no reply records no resolved model', async () => {
  for (const simulate of ['timeout', 'rate-limit', 'network']) {
    assert.equal((await run(JSON.stringify({ simulate }))).resolvedModel, null, simulate);
  }
});

test('an unusable reply keeps the resolved model it reported', async () => {
  const outOfDomain = await run(body([{ ...ok[0], value: 'extreme' }, ok[1]], { resolvedModel: 'mock-9.9.9' }));
  assert.equal(outOfDomain.status, 'error');
  assert.equal(outOfDomain.resolvedModel, 'mock-9.9.9');
  const malformed = await run(body(ok.slice(0, 1), { resolvedModel: 'mock-9.9.9' }));
  assert.equal(malformed.resolvedModel, 'mock-9.9.9');
  assert.equal((await run(body(ok, { resolvedModel: 7, usage: 'x' }))).resolvedModel, null);
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

test('every result carries the pack hash: ok, unknown and error', async () => {
  const results = {
    ok: await run(body(ok)),
    unknown: await run(JSON.stringify({ simulate: 'timeout' })),
    error: await run('{oops'),
  };
  for (const [status, result] of Object.entries(results)) {
    assert.equal(result.status, status);
    assert.equal(result.packHash, packHash(PACK), status);
  }
});

// A credential-shaped string built at runtime, so no key literal sits in the source.
const secretText = () => `ghp_${createHash('sha256').update('pack-secret').digest('hex').slice(0, 36)}`;

test('a pack whose prompt or domain carries a credential-shaped string is refused before anything is sent', async () => {
  for (const mutate of [
    (pack) => { pack.questions[0].prompt = `How risky is this? ${secretText()}`; },
    (pack) => { pack.questions[0].domain = ['low', 'medium', secretText()]; },
  ]) {
    const pack = structuredClone(PACK);
    mutate(pack);
    let calls = 0;
    const provider = { name: 'spy', call: async () => { calls += 1; return { body: JSON.parse(body(ok)) }; } };
    await assert.rejects(
      evaluateDecision({ provider, model: 'm', pack, sanitizedInput: INPUT, retryDelayMs: 0 }),
      (error) => error instanceof PackError && /credential-shaped/.test(error.message),
    );
    assert.equal(calls, 0);
  }
});

test('a pack or question id that matches the id pattern but is hex-secret-shaped is refused before anything is sent', async () => {
  const hexId = createHash('sha256').update('hex-question-id').digest('hex').slice(0, 40);
  for (const mutate of [
    (pack) => { pack.questions[0].id = hexId; },
    (pack) => { pack.id = hexId; },
  ]) {
    const pack = structuredClone(PACK);
    mutate(pack);
    let calls = 0;
    const provider = { name: 'spy', call: async () => { calls += 1; return { body: JSON.parse(body(ok)) }; } };
    await assert.rejects(
      evaluateDecision({ provider, model: 'm', pack, sanitizedInput: INPUT, retryDelayMs: 0 }),
      (error) => error instanceof PackError && /credential-shaped/.test(error.message),
    );
    assert.equal(calls, 0);
  }
});

test('the whole outbound request is bounded: 4 KiB per string, 32 KiB in total', async () => {
  const send = (pack, input = INPUT) => evaluateDecision({
    provider: { name: 'spy', call: async () => ({ body: JSON.parse(body(ok)) }) }, model: 'm', pack, sanitizedInput: input, retryDelayMs: 0,
  });
  const longValue = structuredClone(PACK);
  longValue.questions[0].domain = ['low', 'medium', 'h'.repeat(4097)];
  await assert.rejects(send(longValue), (error) => error instanceof SanitizationError && error.code === 'request-field-too-large');
  const many = structuredClone(PACK);
  for (let i = 0; i < 12; i += 1) many.questions.push({ ...structuredClone(PACK.questions[0]), id: `q${i}`, prompt: 'p'.repeat(500), domain: ['d'.repeat(3000)] });
  await assert.rejects(send(many), (error) => error instanceof SanitizationError && error.code === 'request-too-large');
  assert.equal((await send(PACK)).status, 'ok');
});

const USAGE_ERRORS = [
  ['nested usage', { inputTokens: { n: 1 } }],
  ['a nested unknown key', { extra: { deep: 1 } }],
  ['a negative counter', { inputTokens: -1 }],
  ['a fractional counter', { outputTokens: 1.5 }],
  ['a string counter', { totalTokens: '15' }],
  ['a list', { inputTokens: [1] }],
];

for (const [name, usage] of USAGE_ERRORS) {
  test(`usage with ${name} is malformed`, async () => {
    const result = await run(body(ok, { usage }));
    assert.equal(result.status, 'error');
    assert.equal(result.errorClass, 'malformed-response');
    assert.equal(result.usage, null);
  });
}

test('usage keeps only the documented counters and drops other keys', async () => {
  const result = await run(body(ok, { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0.4, region: 'us' } }));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  assert.deepEqual((await run(body(ok, { usage: { region: 'us' } }))).usage, {});
});

test('a resolved model that is not a valid model ID is malformed, and is not recorded', async () => {
  for (const resolvedModel of ['m'.repeat(129), 'has space', '']) {
    const result = await run(body(ok, { resolvedModel }));
    assert.equal(result.status, 'error', JSON.stringify(resolvedModel));
    assert.equal(result.errorClass, 'malformed-response');
    assert.equal(result.resolvedModel, null);
  }
  assert.equal((await run(body(ok, { resolvedModel: 'm'.repeat(128) }))).status, 'ok');
});

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

test('by default retries back off between attempts', async () => {
  const delays = [];
  const provider = { name: 'scripted', call: async () => ({ failure: 'rate-limit' }) };
  await evaluateDecision({ provider, model: 'm', pack: PACK, sanitizedInput: INPUT, sleep: async (ms) => { delays.push(ms); } });
  assert.equal(delays.length, 2);
  for (const ms of delays) assert.ok(ms >= 100, `retry backoff ${ms} ms is too short to relieve a rate limit`);
});

test('the provider receives the model, the pack ID and each question with only its declared inputs', async () => {
  let seen;
  const provider = { name: 'spy', call: async (request) => { seen = request; return { body: JSON.parse(body(ok)) }; } };
  const pack = structuredClone(PACK);
  pack.questions[0].inputs = ['linesAdded', 'filesChanged'];
  pack.questions[1].inputs = ['ticketCategory'];
  await evaluateDecision({ provider, model: 'm-7', pack, sanitizedInput: INPUT, revision: 'abc123', retryDelayMs: 0 });
  assert.deepEqual(Object.keys(seen).sort(), ['model', 'packId', 'questions'], 'the request carries something besides the model, pack ID and questions');
  assert.equal(seen.model, 'm-7');
  assert.equal(seen.packId, 'change-risk-v1');
  for (const question of seen.questions) assert.deepEqual(Object.keys(question).sort(), ['domain', 'id', 'input', 'kind', 'prompt']);
  assert.deepEqual(seen.questions, [
    { id: 'risk', kind: 'Choice', prompt: PACK.questions[0].prompt, domain: ['low', 'medium', 'high'], input: { filesChanged: 1, linesAdded: 1 } },
    { id: 'needs-deeper-interrogation', kind: 'Noul', prompt: PACK.questions[1].prompt, domain: ['yes', 'no'], input: { ticketCategory: 'none' } },
  ]);
  assert.equal('input' in seen, false, 'the whole input was sent beside the per-question inputs');
});

test('the provider request is canonical: object keys sorted at every level', async () => {
  let seen;
  const provider = { name: 'spy', call: async (request) => { seen = request; return { body: JSON.parse(body(ok)) }; } };
  const pack = structuredClone(PACK);
  pack.questions[0].inputs = ['linesAdded', 'extensionCounts', 'filesChanged'];
  await evaluateDecision({ provider, model: 'm', pack, sanitizedInput: INPUT, retryDelayMs: 0 });
  assert.equal(JSON.stringify(seen), canonicalJson(seen));
});

test('the revision is never sent to the provider', async () => {
  let seen;
  const provider = { name: 'spy', call: async (request) => { seen = request; return { body: JSON.parse(body(ok)) }; } };
  await evaluateDecision({ provider, model: 'm', pack: PACK, sanitizedInput: INPUT, revision: 'f00dfeed', retryDelayMs: 0 });
  assert.ok(!JSON.stringify(seen).includes('f00dfeed'), 'the revision reached the provider');
});

test('a probability or confidence of exactly 0 is valid; below 0 is malformed', async () => {
  const zero = await run(body([{ ...ok[0], probability: 0, confidence: 0 }, ok[1]]));
  assert.equal(zero.status, 'ok');
  assert.equal(zero.answers[0].probability, 0);
  assert.equal(zero.answers[0].confidence, 0);
  for (const key of ['probability', 'confidence']) {
    const negative = await run(body([{ ...ok[0], [key]: -0.01 }, ok[1]]));
    assert.equal(negative.status, 'error', key);
    assert.equal(negative.errorClass, 'malformed-response', key);
  }
});

test('a provider that does not answer within timeoutMs is an unknown timeout, not retried', async () => {
  let calls = 0;
  const provider = { name: 'hang', call: () => { calls += 1; return new Promise(() => {}); } };
  const result = await evaluateDecision({ provider, model: 'm', pack: PACK, sanitizedInput: INPUT, timeoutMs: 20, retryDelayMs: 0 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.errorClass, 'timeout');
  assert.equal(result.attemptCount, 1);
  assert.equal(calls, 1);
});

test('the default timeout is bounded', () => {
  assert.ok(Number.isFinite(DEFAULT_TIMEOUT_MS) && DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 120_000);
});

test('a pinned model (ending in a version) must resolve to itself, or the reply is error', async () => {
  const reply = (resolvedModel) => ({ name: 's', call: async () => ({ body: { ...JSON.parse(body(ok)), resolvedModel } }) });
  const call = (model, resolved) => evaluateDecision({ provider: reply(resolved), model, pack: PACK, sanitizedInput: INPUT, retryDelayMs: 0 });
  const mismatch = await call('mock-1.0.0', 'mock-1.0.1');
  assert.equal(mismatch.status, 'error');
  assert.equal(mismatch.errorClass, 'model-mismatch');
  assert.equal(mismatch.resolvedModel, 'mock-1.0.1');
  assert.equal((await call('mock-1.0.0', 'mock-1.0.0')).status, 'ok');
  assert.equal((await call('mock-1.0.0', undefined)).status, 'ok');
});

test('an alias may resolve to any model, and both are recorded', async () => {
  for (const alias of ['mock-latest', 'mock-1', 'mock-1.0']) {
    const provider = { name: 's', call: async () => ({ body: { ...JSON.parse(body(ok)), resolvedModel: 'mock-1.0.3' } }) };
    const result = await evaluateDecision({ provider, model: alias, pack: PACK, sanitizedInput: INPUT, retryDelayMs: 0 });
    assert.equal(result.status, 'ok', alias);
    assert.equal(result.requestedModel, alias);
    assert.equal(result.resolvedModel, 'mock-1.0.3');
  }
});

test('isPinnedModel: a model ID ending in -<major>.<minor>.<patch> is pinned', () => {
  for (const model of ['jev-1.13.0', 'mock-0.0.1', 'a-10.20.30']) assert.equal(isPinnedModel(model), true, model);
  for (const model of ['jev-latest', 'jev-1.13', 'jev1.13.0', 'mock-1.0.0-beta', 'mock-1.0.0.1']) assert.equal(isPinnedModel(model), false, model);
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
