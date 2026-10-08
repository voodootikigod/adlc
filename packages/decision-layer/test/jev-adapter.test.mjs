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
import { DEFAULT_API_URL, MAX_RESPONSE_BYTES, createJevProvider, jevUnsupported, typesafeRequest } from '../lib/adapters/jev.mjs';
import { jevOptions, providerFor } from '../lib/evaluate.mjs';
import { ConfigError } from '../lib/errors.mjs';
import { validateConfig } from '../lib/config.mjs';
import { scanText } from '../lib/sanitizer.mjs';
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
  const strings = (value) => (typeof value === 'string' ? [value]
    : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]) : []);
  for (const text of strings(FIXTURE)) assert.equal(scanText(text).redactions, 0, text);
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
  assert.equal(sent.init.redirect, 'manual');
  assert.deepEqual(sent.body, accepted);
  assert.ok(!sent.init.body.includes(KEY), 'the key is never in the body');
});

test('the captured jev-latest reply maps to the pack answers', async () => {
  const result = await run({ fetch: replay({ status: 200, body: OK_LATEST.body }).fetch });
  assert.equal(result.status, 'ok');
  assert.equal(result.errorClass, null);
  assert.equal(result.resolvedModel, 'jev-1.13.0');
  assert.deepEqual(result.usage, { inputTokens: 407, outputTokens: 61 });
  assert.deepEqual(result.answers, [
    { id: 'risk', kind: 'Choice', value: 'low', probability: 0.6, confidence: 0.4 },
    { id: 'needs-deeper-interrogation', kind: 'Noul', value: 'no', probability: 0.53 },
  ]);
  assert.equal(reduce({ status: result.status, answers: result.answers, pack: PACK }).outcome, 'unknown');
});

test('the captured pinned reply resolves to the pinned model and is ok', async () => {
  const { fetch, calls } = replay({ status: 200, body: OK_PINNED.body });
  const result = await run({ fetch, model: 'jev-1.13.0' });
  assert.deepEqual(calls[0].body, OK_PINNED.request);
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

for (const status of [500, 503, 599]) {
  test(`a ${status} is unknown (server-error) and is not retried`, async () => {
    const { fetch, calls } = replay({ status, body: {} });
    const result = await run({ fetch });
    assert.deepEqual([result.status, result.errorClass, result.attemptCount, calls.length], ['unknown', 'server-error', 1, 1]);
  });
}

for (const status of [429, 503, 401]) {
  test(`the body of a ${status} is cancelled, not left holding the connection`, async () => {
    let cancelled = 0;
    const fetch = async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1)); },
      cancel() { cancelled += 1; },
    }), { status });
    const result = await run({ fetch });
    assert.equal(cancelled, result.attemptCount);
  });
}

test('a redirect is error and is not followed', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(init);
    return { type: 'opaqueredirect', status: 0, headers: new Headers(), body: null };
  };
  const result = await run({ fetch });
  assert.deepEqual([result.status, result.errorClass, calls.length], ['error', 'http-redirect', 1]);
});

test('a body that never ends is cut off at the limit and is error', async () => {
  let pulled = 0;
  let cancelled = false;
  // Endless as far as the limit can tell, but finite: the stream closes after
  // 64 chunks (eight times the limit), so a limit that stops working fails the
  // assertions below instead of reading without bound. 64 is a literal so it
  // does not move with MAX_RESPONSE_BYTES.
  const body = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 64) { controller.close(); return; }
      controller.enqueue(new Uint8Array(8192));
    },
    cancel() { cancelled = true; },
  });
  const fetch = async () => new Response(body, { status: 200 });
  const result = await run({ fetch });
  assert.deepEqual([result.status, result.errorClass], ['error', 'response-too-large']);
  assert.equal(cancelled, true);
  assert.ok(pulled * 8192 <= MAX_RESPONSE_BYTES + 2 * 8192, `read ${pulled} chunks`);
});

test('a declared Content-Length over the limit is error without reading the body', async () => {
  let pulled = 0;
  const body = new ReadableStream({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1)); } });
  const fetch = async () => new Response(body, { status: 200, headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } });
  const result = await run({ fetch });
  assert.deepEqual([result.status, result.errorClass], ['error', 'response-too-large']);
  assert.ok(pulled <= 1, `pulled ${pulled}`);
});

test('a 2xx body that breaks off mid-read is unknown (interrupted-response) and is not retried', async () => {
  let reads = 0;
  const fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      reads += 1;
      controller.error(new Error('reset'));
    },
  }), { status: 200 });
  const result = await run({ fetch });
  assert.deepEqual([result.status, result.errorClass, result.attemptCount, reads], ['unknown', 'interrupted-response', 1, 1]);
});

test('a Choice reply without a probability for its choice keeps the choice without one', async () => {
  const result = await run({ fetch: replay(okWith({ risk: { type: 'choice', choice: 'low', probabilities: {}, confidence: 0.4 } })).fetch });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.answers[0], { id: 'risk', kind: 'Choice', value: 'low', confidence: 0.4 });
});

test('questions that declare different inputs are rejected before anything is sent: one run is one call', async () => {
  const { fetch, calls } = replay({ status: 200, body: OK_LATEST.body });
  const pack = { ...PACK, questions: [{ ...PACK.questions[0], inputs: ['linesAdded'] }, { ...PACK.questions[1], inputs: ['filesChanged'] }] };
  const result = await run({ fetch, pack });
  assert.deepEqual([result.status, result.errorClass, result.attemptCount, calls.length], ['error', 'unsupported-pack', 0, 0]);
});

test('a Score question is rejected before anything is sent: no live Score reply has been captured', async () => {
  const { fetch, calls } = replay({ status: 200, body: OK_LATEST.body });
  const pack = {
    ...PACK,
    questions: [{ id: 'severity', kind: 'Score', prompt: 'How severe?', domain: { min: 1, max: 3 }, phases: ['P0'], inputs: ['linesAdded'] }],
    aggregation: { escalateIf: [], allowIf: [] },
  };
  const result = await run({ fetch, pack });
  assert.deepEqual([result.status, result.errorClass, result.attemptCount, calls.length], ['error', 'unsupported-question', 0, 0]);
});

test('typesafeRequest sends a Choice domain as criteria and a Noul without criteria', () => {
  assert.deepEqual(typesafeRequest({
    model: 'jev-latest',
    questions: [
      { id: 'risk', kind: 'Choice', prompt: 'p', domain: ['low', 'high'], input: { a: 1 } },
      { id: 'n', kind: 'Noul', prompt: 'q', domain: ['yes', 'no'], input: { a: 1 } },
    ],
  }), {
    model: 'jev-latest',
    state: { a: 1 },
    questions: { risk: { type: 'choice', instructions: 'p', criteria: { low: 'low', high: 'high' } }, n: { type: 'noul', instructions: 'q' } },
  });
});

for (const apiUrl of ['http://api.typesafe.ai/v1/systemone', 'https://u:p@api.typesafe.ai/v1/systemone']) {
  test(`the provider itself refuses to send the key to ${apiUrl}`, () => {
    assert.throws(() => createJevProvider({ apiKey: KEY, apiUrl, fetch: async () => assert.fail('sent') }), TypeError);
  });
}

const SHADOW_JEV = { mode: 'shadow', provider: 'jev', model: 'jev-latest', pack: 'change-risk-v1' };

test('TYPESAFE_API_KEY takes precedence over JEV_API_KEY, which is the fallback', () => {
  const config = validateConfig(SHADOW_JEV, { TYPESAFE_API_KEY: 'primary', JEV_API_KEY: 'fallback' });
  assert.equal(jevOptions(config, { TYPESAFE_API_KEY: 'primary', JEV_API_KEY: 'fallback' }).apiKey, 'primary');
  assert.equal(jevOptions(config, { JEV_API_KEY: 'fallback' }).apiKey, 'fallback');
});

test('an https TYPESAFE_API_URL replaces the default endpoint, and the request goes there', async () => {
  const env = { TYPESAFE_API_KEY: 'primary', TYPESAFE_API_URL: 'https://proxy.example.test/typesafe/v1/systemone' };
  const options = jevOptions(validateConfig(SHADOW_JEV, env), env);
  assert.deepEqual(options, { apiKey: 'primary', apiUrl: 'https://proxy.example.test/typesafe/v1/systemone' });
  assert.equal(jevOptions(validateConfig(SHADOW_JEV, { TYPESAFE_API_KEY: 'k' }), { TYPESAFE_API_KEY: 'k' }).apiUrl, DEFAULT_API_URL);
  const { fetch, calls } = replay({ status: 200, body: OK_LATEST.body });
  await evaluateDecision({ provider: createJevProvider({ ...options, fetch }), model: 'jev-latest', pack: PACK, sanitizedInput: INPUT, retryDelayMs: 0 });
  assert.equal(calls[0].url, options.apiUrl);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer primary');
});

for (const [name, body] of [
  ['null', 'null'],
  ['an array', '[]'],
  ['a number', '7'],
  ['answers as an array', JSON.stringify({ model: 'jev-1.13.0', answers: [] })],
  ['answers missing', JSON.stringify({ model: 'jev-1.13.0' })],
  ['a usage that is not an object', JSON.stringify({ ...OK_LATEST.body, usage: 'x' })],
  ['a usage that is an array', JSON.stringify({ ...OK_LATEST.body, usage: [] })],
]) {
  test(`a 2xx reply with ${name} is error (malformed)`, async () => {
    const result = await run({ fetch: replay({ status: 200, body }).fetch });
    assert.deepEqual([result.status, result.errorClass], ['error', 'malformed-response']);
  });
}

test('a malformed reply still records the model TypeSafe reported', async () => {
  const result = await run({ fetch: replay({ status: 200, body: { model: 'jev-1.13.0', answers: [] } }).fetch });
  assert.deepEqual([result.status, result.resolvedModel], ['error', 'jev-1.13.0']);
});

for (const model of ['jev-1.13.0', 'jev-latest']) {
  test(`a reply that reports no model is error, so a pin cannot pass unchecked (${model})`, async () => {
    const { model: _omitted, ...body } = OK_LATEST.body;
    const result = await run({ fetch: replay({ status: 200, body }).fetch, model });
    assert.deepEqual([result.status, result.errorClass, result.resolvedModel], ['error', 'malformed-response', null]);
  });
}

for (const key of ['abc\r', 'ab c', 'ab\ncd']) {
  test(`a key a header cannot carry (${JSON.stringify(key)}) is refused before anything is sent`, () => {
    assert.throws(() => validateConfig(SHADOW_JEV, { TYPESAFE_API_KEY: key }), ConfigError);
    assert.throws(() => validateConfig(SHADOW_JEV, { JEV_API_KEY: key }), ConfigError);
  });
}

test('a key with a trailing carriage return is refused by config, the provider and providerFor', () => {
  assert.throws(() => validateConfig(SHADOW_JEV, { TYPESAFE_API_KEY: 'abc\r' }), /characters a header cannot carry/);
  assert.throws(() => createJevProvider({ apiKey: 'abc\r' }), TypeError);
  for (const variable of ['TYPESAFE_API_KEY', 'JEV_API_KEY']) {
    assert.throws(() => providerFor({ ...SHADOW_JEV, apiUrl: DEFAULT_API_URL }, { [variable]: 'abc\r' }), (error) => error instanceof ConfigError && /header cannot carry/.test(error.message));
  }
  assert.throws(() => providerFor({ ...SHADOW_JEV, apiUrl: DEFAULT_API_URL }, {}), ConfigError);
});

test('providerFor hands the jev provider the precedence key and the configured URL', async () => {
  const env = { TYPESAFE_API_KEY: 'primary', JEV_API_KEY: 'fallback', TYPESAFE_API_URL: 'https://proxy.example.test/v1/systemone' };
  const config = validateConfig(SHADOW_JEV, env);
  const original = globalThis.fetch;
  const { fetch, calls } = replay({ status: 200, body: OK_LATEST.body });
  globalThis.fetch = fetch;
  try {
    const provider = providerFor(config, env);
    await evaluateDecision({ provider, model: 'jev-latest', pack: PACK, sanitizedInput: INPUT, retryDelayMs: 0 });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls[0].url, 'https://proxy.example.test/v1/systemone');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer primary');
});

for (const status of [301, 302, 307]) {
  test(`a real ${status} is error (http-${status}) and its Location is never fetched`, async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push(url);
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status, headers: { location: 'https://elsewhere.example.test/' } });
    };
    const result = await run({ fetch });
    assert.deepEqual([result.status, result.errorClass, calls], ['error', `http-${status}`, [DEFAULT_API_URL]]);
  });
}

for (const status of [200, 204]) {
  test(`a ${status} with no body is error (malformed)`, async () => {
    const result = await run({ fetch: async () => new Response(null, { status }) });
    assert.deepEqual([result.status, result.errorClass], ['error', 'malformed-response']);
  });
}

test('a Choice label that names an Object prototype member, absent from probabilities, keeps no probability', async () => {
  const pack = { ...PACK, questions: [{ ...PACK.questions[0], domain: ['constructor', 'toString'] }, PACK.questions[1]] };
  const body = { ...OK_LATEST.body, answers: { ...OK_LATEST.body.answers, risk: { type: 'choice', choice: 'constructor', probabilities: {}, confidence: 0.5 } } };
  const result = await run({ fetch: replay({ status: 200, body }).fetch, pack });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.answers[0], { id: 'risk', kind: 'Choice', value: 'constructor', confidence: 0.5 });
});

test('jevUnsupported names why a pack cannot be asked in one call, ignoring input order', () => {
  assert.equal(jevUnsupported(PACK), null);
  const reordered = { questions: [{ kind: 'Choice', inputs: ['a', 'b'] }, { kind: 'Noul', inputs: ['b', 'a'] }] };
  assert.equal(jevUnsupported(reordered), null);
  assert.equal(jevUnsupported({ questions: [{ kind: 'Choice', inputs: ['a'] }, { kind: 'Noul', inputs: ['b'] }] }), 'unsupported-pack');
  assert.equal(jevUnsupported({ questions: [{ kind: 'Score', inputs: ['a'] }] }), 'unsupported-question');
});

for (const [name, answer] of [
  ['a bare "yes" for a Noul question', { 'needs-deeper-interrogation': 'yes' }],
  ['a Noul whose noul is the string "yes"', { 'needs-deeper-interrogation': { type: 'noul', noul: 'yes' } }],
  ['a Noul whose noul is the string "no"', { 'needs-deeper-interrogation': { type: 'noul', noul: 'no' } }],
  ['a bare "low" for a Choice question', { risk: 'low' }],
  ['a Choice answer without a type', { risk: { choice: 'low', probabilities: { low: 1 } } }],
  ['an answer that is an array', { risk: ['low'] }],
]) {
  test(`${name} is error (malformed), never an in-domain decision`, async () => {
    const result = await run({ fetch: replay(okWith(answer)).fetch });
    assert.deepEqual([result.status, result.errorClass, result.answers], ['error', 'malformed-response', []]);
  });
}

for (const [name, answer] of [
  ['a Choice answer without a choice', { risk: { type: 'choice', probabilities: { low: 1 } } }],
  ['a Choice answer whose choice is a number', { risk: { type: 'choice', choice: 1, probabilities: { 1: 1 } } }],
]) {
  test(`${name} is error (malformed)`, async () => {
    const result = await run({ fetch: replay(okWith(answer)).fetch });
    assert.deepEqual([result.status, result.errorClass], ['error', 'malformed-response']);
  });
}

for (const [name, usage, expected] of [
  ['no usage', undefined, null],
  ['a null usage', null, null],
  ['only input_tokens', { input_tokens: 9 }, { inputTokens: 9 }],
  ['only output_tokens', { output_tokens: 3 }, { outputTokens: 3 }],
]) {
  test(`a reply with ${name} is still ok, with usage ${JSON.stringify(expected)}`, async () => {
    const { usage: _dropped, ...rest } = OK_LATEST.body;
    const body = usage === undefined ? rest : { ...rest, usage };
    const result = await run({ fetch: replay({ status: 200, body }).fetch });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.usage, expected);
  });
}
