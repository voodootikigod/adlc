// keyless-bridge.test.mjs — Phase B (T3): the keyless two-phase gate cascade.
// Pure/offline: injects a stub spawn + ask, no real gate or model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPrompts, runGateKeyless, makeAsk } from '../lib/keyless-bridge.mjs';

// ---- extractPrompts ----
test('extractPrompts: single-prompt gate → one segment', () => {
  const out = '=== system ===\nyou are an auditor\n=== user ===\naudit this';
  const p = extractPrompts(out);
  assert.equal(p.length, 1);
  assert.match(p[0].text, /auditor/);
});

test('extractPrompts: fan-out gate with "prompt N of M" → ordered segments', () => {
  const out = [
    '--- prompt 1 of 2 ---',
    'reading prompt',
    '--- prompt 2 of 2 ---',
    'divergence prompt',
  ].join('\n');
  const p = extractPrompts(out);
  assert.equal(p.length, 2);
  assert.deepEqual(p.map((x) => x.index), [1, 2]);
  assert.match(p[0].text, /reading/);
  assert.match(p[1].text, /divergence/);
});

test('extractPrompts: empty output → []', () => {
  assert.deepEqual(extractPrompts(''), []);
  assert.deepEqual(extractPrompts('   \n'), []);
});

// ---- runGateKeyless ----
function stubSpawn(stdout, status = 0, stderr = '') {
  return (_bin, args) => {
    assert.ok(args.includes('--prompt-only'), 'gate is run with --prompt-only');
    return { status, stdout, stderr };
  };
}

test('runGateKeyless: asks each prompt in order, threads prior answers', async () => {
  const spawnImpl = stubSpawn('--- prompt 1 of 2 ---\nA\n--- prompt 2 of 2 ---\nB');
  const seen = [];
  const ask = (text, ctx) => { seen.push({ text, prior: ctx.prior.length }); return `ans:${text}`; };
  const { prompts, answers } = await runGateKeyless({ bin: 'adlc', args: ['parallax'], ask, spawnImpl });
  assert.equal(prompts.length, 2);
  assert.deepEqual(answers, ['ans:A', 'ans:B']);
  assert.deepEqual(seen.map((s) => s.prior), [0, 1]); // 2nd ask sees 1 prior answer
});

test('runGateKeyless: ASYNC ask — answers are resolved values, prior holds resolved (not Promises)', async () => {
  const spawnImpl = stubSpawn('--- prompt 1 of 2 ---\nA\n--- prompt 2 of 2 ---\nB');
  const priorSeen = [];
  // Realistic host SDK: async prompt call.
  const ask = async (text, ctx) => { priorSeen.push(ctx.prior.slice()); return `ans:${text}`; };
  const { answers } = await runGateKeyless({ bin: 'adlc', args: ['parallax'], ask, spawnImpl });
  assert.deepEqual(answers, ['ans:A', 'ans:B']); // resolved strings, not Promises
  // the 2nd prompt's prior must contain the RESOLVED first answer, not a pending Promise
  assert.deepEqual(priorSeen[1], ['ans:A']);
  for (const a of answers) assert.equal(typeof a, 'string');
});

test('runGateKeyless: gate operational failure (status!=0) throws', async () => {
  const spawnImpl = stubSpawn('', 1, 'no provider');
  await assert.rejects(() => runGateKeyless({ bin: 'adlc', args: ['spec-lint'], ask: () => 'x', spawnImpl }), /exited 1/);
});

test('runGateKeyless: requires an ask function', async () => {
  await assert.rejects(() => runGateKeyless({ bin: 'adlc', spawnImpl: stubSpawn('p') }), /ask\(prompt\) function is required/);
});

// ---- makeAsk against the v2 generate API (`ctx.generate.text`) ----
import { answerFromMessages, makeSessionAsk } from '../lib/keyless-bridge.mjs';

/** A mock `ctx.generate` capturing `text` calls. */
function mockGenerate({ reply = 'VERDICT: clear' } = {}) {
  const calls = [];
  return { calls, text: async (req) => { calls.push(req); return { text: reply }; } };
}

test('makeAsk: one stateless generate.text call per prompt, returns its text', async () => {
  const generate = mockGenerate({ reply: '  VERDICT: SHIP\n' });
  const ask = makeAsk(generate, { model: { providerID: 'mock', modelID: 'm' } });
  assert.equal(typeof ask, 'function');
  assert.equal(await ask('audit this spec'), 'VERDICT: SHIP');
  // v1 { providerID, modelID } refs are translated to the v2 { providerID, id } shape
  assert.deepEqual(generate.calls, [{ prompt: 'audit this spec', model: { providerID: 'mock', id: 'm' } }]);
});

test('makeAsk: omits model when not given (host default)', async () => {
  const generate = mockGenerate();
  await makeAsk(generate)('q');
  assert.deepEqual(generate.calls, [{ prompt: 'q' }]);
});

test('makeAsk: a reply without text is an empty answer, not a crash', async () => {
  assert.equal(await makeAsk({ text: async () => ({}) })('q'), '');
});

test('makeAsk: no generate API → null (caller fails closed)', () => {
  assert.equal(makeAsk({}), null);
  assert.equal(makeAsk(null), null);
  assert.equal(makeAsk(undefined), null);
});

// ---- P5 finding: timeout + prompt cap (no hung turn / unbounded fan-out) ----
test('makeAsk: a hung generation times out', async () => {
  const ask = makeAsk({ text: () => new Promise(() => {}) }, { timeoutMs: 20 });
  await assert.rejects(() => ask('q'), /keyless: generate\.text timed out/);
});

// ---- makeSessionAsk: child sessions for tool-using work (prosecution lenses) ----
const assistant = (...texts) => ({ id: 'msg_a', type: 'assistant', content: texts.map((text) => ({ type: 'text', text })) });

/** A mock v2 `ctx.session` capturing create/prompt/wait/context calls. */
function mockSession({ messages = [assistant('VERDICT: clear')], sessionID = 'ses_child' } = {}) {
  const calls = { create: [], prompt: [], wait: [], context: [] };
  return {
    calls,
    create: async (req) => { calls.create.push(req); return { id: sessionID }; },
    prompt: async (req) => { calls.prompt.push(req); return { id: 'inb_1' }; },
    wait: async (req) => { calls.wait.push(req); },
    context: async (req) => { calls.context.push(req); return messages; },
  };
}

const PERMS = [{ action: '*', resource: '*', effect: 'deny' }];

test('answerFromMessages: last assistant message, text content only', () => {
  const msgs = [
    assistant('old'),
    { type: 'user', content: [{ type: 'text', text: 'q' }] },
    { type: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'a' }, { type: 'tool' }, { type: 'text', text: 'b' }] },
  ];
  assert.equal(answerFromMessages(msgs), 'ab');
  assert.equal(answerFromMessages([]), '');
  assert.equal(answerFromMessages(null), '');
  assert.equal(answerFromMessages({ data: msgs }), '', 'only the array shape session.context resolves to');
});

test('makeSessionAsk: creates a permissioned child, prompts, waits, reads context', async () => {
  const session = mockSession({ messages: [assistant('VERDICT: SHIP')], sessionID: 'ses_c1' });
  const ask = makeSessionAsk(session, { title: 't', permissions: PERMS, directory: '/repo', model: { providerID: 'p', id: 'm' } });
  assert.equal(await ask('audit this'), 'VERDICT: SHIP');
  assert.deepEqual(session.calls.create, [{ title: 't', permissions: PERMS, location: { directory: '/repo' }, model: { providerID: 'p', id: 'm' } }]);
  assert.deepEqual(session.calls.prompt, [{ sessionID: 'ses_c1', text: 'audit this' }]);
  assert.deepEqual(session.calls.wait, [{ sessionID: 'ses_c1' }]);
  assert.deepEqual(session.calls.context, [{ sessionID: 'ses_c1' }]);
});

test('makeSessionAsk: the reply is read only after the child went idle', async () => {
  const order = [];
  const session = mockSession();
  const { wait, context } = session;
  session.wait = async (r) => { order.push('wait'); return wait(r); };
  session.context = async (r) => { order.push('context'); return context(r); };
  await makeSessionAsk(session, { title: 't', permissions: PERMS })('q');
  assert.deepEqual(order, ['wait', 'context']);
});

test('makeSessionAsk: missing any required session method → null (caller fails closed)', () => {
  for (const missing of ['create', 'prompt', 'wait', 'context']) {
    const session = mockSession();
    delete session[missing];
    assert.equal(makeSessionAsk(session, { title: 't', permissions: PERMS }), null, `no ${missing}`);
  }
  assert.equal(makeSessionAsk(null, { title: 't', permissions: PERMS }), null);
});

test('makeSessionAsk: create without a session id rejects (never prompts an unknown session)', async () => {
  const session = mockSession();
  session.create = async () => ({});
  await assert.rejects(() => makeSessionAsk(session, { title: 't', permissions: PERMS, label: 'lens' })('q'), /lens: child session\.create returned no session id/);
  assert.equal(session.calls.prompt.length, 0);
});

test('makeSessionAsk: a child that never goes idle times out', async () => {
  const session = mockSession();
  session.wait = () => new Promise(() => {});
  await assert.rejects(() => makeSessionAsk(session, { title: 't', permissions: PERMS, timeoutMs: 20, label: 'lens' })('q'), /lens: child session reply timed out/);
});

test('runGateKeyless: a gate emitting too many prompts is refused (no unbounded fan-out)', async () => {
  const many = Array.from({ length: 20 }, (_, i) => `--- prompt ${i + 1} of 20 ---\np${i}`).join('\n');
  const spawnImpl = stubSpawn(many);
  let asks = 0;
  const ask = () => { asks++; return 'a'; };
  await assert.rejects(() => runGateKeyless({ bin: 'adlc', args: ['parallax'], ask, spawnImpl, maxPrompts: 12 }), /refusing to spawn/);
  assert.equal(asks, 0, 'no child sessions spawned when the cap is exceeded');
});

test('runGateKeyless threads through the real makeAsk shape', async () => {
  const ask = makeAsk(mockGenerate({ reply: 'answer-A' }));
  const spawnImpl = stubSpawn('single prompt block');
  const { answers } = await runGateKeyless({ bin: 'adlc', args: ['spec-lint'], ask, spawnImpl });
  assert.deepEqual(answers, ['answer-A']);
});
