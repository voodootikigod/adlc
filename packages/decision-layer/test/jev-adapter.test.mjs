// The Jev provider, replayed against live TypeSafe responses captured on
// 2026-10-08 (test/fixtures/jev-live-2026-10-08.json): the request it builds,
// how each captured reply maps onto the pack's answers, and the status rules
// (no answer is unknown, an unusable answer or a rejection is error). Every
// call goes through an injected fetch; nothing here reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNoNetwork } from './helpers/no-network.mjs';
import { DEFAULT_API_URL, createJevProvider, typesafeRequests } from '../lib/adapters/jev.mjs';
import { MAX_RETRIES, evaluateDecision } from '../lib/provider.mjs';
import { reduce } from '../lib/reducer.mjs';

installNoNetwork();

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = JSON.parse(readFileSync(join(HERE, '..', 'packs', 'change-risk-v1', 'pack.json'), 'utf8'));
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'jev-live-2026-10-08.json'), 'utf8'));
const capture = (label) => FIXTURE.captures.find((entry) => entry.label === label);
const OK_LATEST = capture('ok-latest');
const OK_PINNED = capture('ok-pinned');
const AUTH_INVALID = capture('auth-invalid-key');
const INPUT = OK_LATEST.request.state;
const KEY = 'test-key-not-real';

/** A fetch that replays `responses` in order and records each call. */
function replay(...responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses[Math.min(calls.length, responses.length) - 1];
    if (next instanceof Error) throw next;
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const run = ({ fetch, model = 'jev-latest', pack = PACK, input = INPUT, timeoutMs }) => evaluateDecision({
  provider: createJevProvider({ apiKey: KEY, fetch }),
  model,
  pack,
  sanitizedInput: input,
  retryDelayMs: 0,
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

const okWith = (answers) => ({ status: 200, body: { ...OK_LATEST.body, answers: { ...OK_LATEST.body.answers, ...answers } } });

test('the fixture is a live capture with the endpoint, model and date, and no key', () => {
  assert.equal(FIXTURE.endpoint, DEFAULT_API_URL);
  assert.match(FIXTURE.capturedAt, /^2026-10-08T/);
  assert.equal(OK_LATEST.status, 200);
  assert.equal(OK_LATEST.body.model, 'jev-1.13.0');
  assert.equal(AUTH_INVALID.status, 401);
  assert.doesNotMatch(JSON.stringify(FIXTURE), /Bearer\s+(?!<)/);
});

test('the request matches the shape the live API accepted', async () => {
  const { fetch, calls } = replay({ status: 200, body: OK_LATEST.body });
  await run({ fetch });
  assert.equal(calls.length, 1);
  const [sent] = calls;
  const accepted = OK_LATEST.request;
  assert.equal(sent.url, DEFAULT_API_URL);
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(sent.init.redirect, 'error');
  assert.equal(sent.body.model, accepted.model);
  assert.deepEqual(sent.body.state, accepted.state);
  assert.deepEqual(Object.keys(sent.body.questions).sort(), Object.keys(accepted.questions).sort());
  for (const [id, question] of Object.entries(accepted.questions)) {
    assert.equal(sent.body.questions[id].type, question.type, id);
    assert.equal(sent.body.questions[id].instructions, question.instructions, id);
    assert.deepEqual(Object.keys(sent.body.questions[id].criteria ?? {}).sort(), Object.keys(question.criteria ?? {}).sort(), id);
  }
  assert.ok(!sent.init.body.includes(KEY), 'the key is never in the body');
});

test('the captured jev-latest reply maps to the pack answers', async () => {
  const result = await run({ fetch: replay({ status: 200, body: OK_LATEST.body }).fetch });
  assert.equal(result.status, 'ok');
  assert.equal(result.errorClass, null);
  assert.equal(result.resolvedModel, 'jev-1.13.0');
  assert.deepEqual(result.usage, { inputTokens: 410, outputTokens: 61 });
  assert.deepEqual(result.answers, [
    { id: 'risk', kind: 'Choice', value: 'medium', probability: 0.53, confidence: 0.3 },
    { id: 'needs-deeper-interrogation', kind: 'Noul', value: 'no', probability: 0.52 },
  ]);
  assert.equal(reduce({ status: result.status, answers: result.answers, pack: PACK }).outcome, 'unknown');
});

test('the captured pinned reply resolves to the pinned model and is ok', async () => {
  const result = await run({ fetch: replay({ status: 200, body: OK_PINNED.body }).fetch, model: 'jev-1.13.0' });
  assert.equal(result.status, 'ok');
  assert.equal(result.resolvedModel, 'jev-1.13.0');
});

test('a pinned model resolved to another version is error', async () => {
  const result = await run({ fetch: replay({ status: 200, body: OK_PINNED.body }).fetch, model: 'jev-1.14.0' });
  assert.equal(result.status, 'error');
  assert.equal(result.errorClass, 'model-mismatch');
  assert.equal(result.resolvedModel, 'jev-1.13.0');
});

test('the captured 401 is error and is not retried', async () => {
  const { fetch, calls } = replay({ status: AUTH_INVALID.status, body: AUTH_INVALID.body });
  const result = await run({ fetch });
  assert.equal(result.status, 'error');
  assert.equal(result.errorClass, 'http-401');
  assert.equal(result.attemptCount, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(result.answers, []);
});

test('Noul: P(yes) >= 0.5 is yes with probability p, below is no with 1 - p, and a tie is yes', async () => {
  for (const [p, value, probability] of [[0.48, 'no', 0.52], [0.5, 'yes', 0.5], [0.9, 'yes', 0.9], [0, 'no', 1], [1, 'yes', 1]]) {
    const result = await run({ fetch: replay(okWith({ 'needs-deeper-interrogation': { type: 'noul', noul: p } })).fetch });
    assert.equal(result.status, 'ok', String(p));
    assert.deepEqual(result.answers[1], { id: 'needs-deeper-interrogation', kind: 'Noul', value, probability }, String(p));
  }
});

for (const [name, answer] of [
  ['a Noul probability above 1', { 'needs-deeper-interrogation': { type: 'noul', noul: 1.2 } }],
  ['a Noul probability below 0', { 'needs-deeper-interrogation': { type: 'noul', noul: -0.1 } }],
  ['a Noul answer typed as a choice', { 'needs-deeper-interrogation': { type: 'choice', choice: 'yes' } }],
  ['an unknown answer type', { risk: { type: 'verdict', value: 'low' } }],
  ['an extra answer', { extra: { type: 'noul', noul: 0.5 } }],
]) {
  test(`${name} is error (malformed)`, async () => {
    const result = await run({ fetch: replay(okWith(answer)).fetch });
    assert.equal(result.status, 'error');
    assert.equal(result.errorClass, 'malformed-response');
  });
}

for (const [name, answer] of [
  ['a Choice outside the domain', { risk: { type: 'choice', choice: 'severe', probabilities: { severe: 1 }, confidence: 0.9 } }],
  ['a Noul without a number', { 'needs-deeper-interrogation': { type: 'noul' } }],
]) {
  test(`${name} is error (out of domain)`, async () => {
    const result = await run({ fetch: replay(okWith(answer)).fetch });
    assert.equal(result.status, 'error');
    assert.equal(result.errorClass, 'out-of-domain');
  });
}

test('a reply missing an answer is error', async () => {
  const { risk } = OK_LATEST.body.answers;
  const result = await run({ fetch: replay({ status: 200, body: { ...OK_LATEST.body, answers: { risk } } }).fetch });
  assert.equal(result.status, 'error');
  assert.equal(result.errorClass, 'malformed-response');
});

test('a 2xx body that is not JSON is error', async () => {
  const result = await run({ fetch: replay({ status: 200, body: '<html>gateway</html>' }).fetch });
  assert.equal(result.status, 'error');
  assert.equal(result.errorClass, 'malformed-response');
});

test('an oversized 2xx body is error', async () => {
  const result = await run({ fetch: replay({ status: 200, body: 'x'.repeat(70_000) }).fetch });
  assert.equal(result.status, 'error');
  assert.equal(result.errorClass, 'response-too-large');
});

test('a 400 is error and is not retried', async () => {
  const { fetch, calls } = replay({ status: 400, body: { detail: { error_type: 'invalid_request_error' } } });
  const result = await run({ fetch });
  assert.deepEqual([result.status, result.errorClass, calls.length], ['error', 'http-400', 1]);
});

for (const [name, response, errorClass] of [
  ['429', { status: 429, body: {} }, 'rate-limit'],
  ['529', { status: 529, body: {} }, 'rate-limit'],
  ['503', { status: 503, body: {} }, 'network'],
  ['a network failure', new TypeError('fetch failed'), 'network'],
]) {
  test(`${name} is unknown after ${MAX_RETRIES} retries`, async () => {
    const { fetch, calls } = replay(response);
    const result = await run({ fetch });
    assert.equal(result.status, 'unknown');
    assert.equal(result.errorClass, errorClass);
    assert.equal(result.attemptCount, MAX_RETRIES + 1);
    assert.equal(calls.length, MAX_RETRIES + 1);
    assert.equal(result.resolvedModel, null);
  });
}

test('a retried 429 that then succeeds is ok and counts both attempts', async () => {
  const result = await run({ fetch: replay({ status: 429, body: {} }, { status: 200, body: OK_LATEST.body }).fetch });
  assert.equal(result.status, 'ok');
  assert.equal(result.attemptCount, 2);
});

test('a call that does not answer in time is unknown, not retried, and its fetch is aborted', async () => {
  let signal;
  const fetch = (_url, init) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  };
  const result = await run({ fetch, timeoutMs: 20 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.errorClass, 'timeout');
  assert.equal(result.attemptCount, 1);
  assert.equal(signal.aborted, true);
});

const twoInputPack = {
  ...PACK,
  questions: [
    { ...PACK.questions[0], inputs: ['linesAdded'] },
    { ...PACK.questions[1], inputs: ['filesChanged'] },
  ],
};

test('questions that declare different inputs are asked in separate calls, each seeing only its inputs', async () => {
  const { risk } = OK_LATEST.body.answers;
  const noul = OK_LATEST.body.answers['needs-deeper-interrogation'];
  const { fetch, calls } = replay(
    { status: 200, body: { model: 'jev-1.13.0', answers: { risk }, usage: { input_tokens: 10, output_tokens: 2 } } },
    { status: 200, body: { model: 'jev-1.13.0', answers: { 'needs-deeper-interrogation': noul }, usage: { input_tokens: 5, output_tokens: 1 } } },
  );
  const result = await run({ fetch, pack: twoInputPack });
  assert.equal(result.status, 'ok');
  assert.deepEqual(calls.map((call) => call.body.state), [{ linesAdded: INPUT.linesAdded }, { filesChanged: INPUT.filesChanged }]);
  assert.deepEqual(calls.map((call) => Object.keys(call.body.questions)), [['risk'], ['needs-deeper-interrogation']]);
  assert.deepEqual(result.usage, { inputTokens: 15, outputTokens: 3 });
});

test('separate calls resolved to different models are error', async () => {
  const { risk } = OK_LATEST.body.answers;
  const noul = OK_LATEST.body.answers['needs-deeper-interrogation'];
  const { fetch } = replay(
    { status: 200, body: { model: 'jev-1.13.0', answers: { risk } } },
    { status: 200, body: { model: 'jev-1.14.0', answers: { 'needs-deeper-interrogation': noul } } },
  );
  const result = await run({ fetch, pack: twoInputPack });
  assert.equal(result.status, 'error');
  assert.equal(result.errorClass, 'malformed-response');
});

test('a failure in a later call fails the whole run without partial answers', async () => {
  const { risk } = OK_LATEST.body.answers;
  const { fetch } = replay(
    { status: 200, body: { model: 'jev-1.13.0', answers: { risk } } },
    { status: 401, body: AUTH_INVALID.body },
  );
  const result = await run({ fetch, pack: twoInputPack });
  assert.deepEqual([result.status, result.errorClass, result.answers], ['error', 'http-401', []]);
});

const scorePack = (domain) => ({
  ...PACK,
  questions: [{ id: 'severity', kind: 'Score', prompt: 'How severe?', domain, phases: ['P0'], inputs: ['linesAdded'] }],
  aggregation: { escalateIf: [], allowIf: [] },
});

test('a Score question is sent as its integer levels and answered as min plus the weighted position', async () => {
  const { fetch, calls } = replay({ status: 200, body: { model: 'jev-1.13.0', answers: { severity: { type: 'score', score: 1.5, confidence: 0.8, probabilities: { 0: 0, 1: 0.5, 2: 0.5 } } } } });
  const result = await run({ fetch, pack: scorePack({ min: 1, max: 3 }) });
  assert.deepEqual(calls[0].body.questions.severity, { type: 'score', instructions: 'How severe?', criteria: ['1', '2', '3'] });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.answers, [{ id: 'severity', kind: 'Score', value: 2.5, confidence: 0.8 }]);
});

for (const domain of [{ min: 0, max: 0.5 }, { min: 0, max: 10 }]) {
  test(`a Score domain Jev cannot express (${JSON.stringify(domain)}) is error before anything is sent`, async () => {
    const { fetch, calls } = replay({ status: 200, body: OK_LATEST.body });
    const result = await run({ fetch, pack: scorePack(domain) });
    assert.deepEqual([result.status, result.errorClass, calls.length], ['error', 'unsupported-question', 0]);
  });
}

test('typesafeRequests sends a Choice domain as criteria and a Noul without criteria', () => {
  const [group] = typesafeRequests({
    model: 'jev-latest',
    questions: [
      { id: 'risk', kind: 'Choice', prompt: 'p', domain: ['low', 'high'], input: { a: 1 } },
      { id: 'n', kind: 'Noul', prompt: 'q', domain: ['yes', 'no'], input: { a: 1 } },
    ],
  });
  assert.deepEqual(group, {
    model: 'jev-latest',
    state: { a: 1 },
    questions: { risk: { type: 'choice', instructions: 'p', criteria: { low: 'low', high: 'high' } }, n: { type: 'noul', instructions: 'q' } },
  });
});
