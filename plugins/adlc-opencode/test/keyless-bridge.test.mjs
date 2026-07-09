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

// ---- makeAsk against the real source-verified SDK (v1.17.13) ----
import { answerFromPrompt } from '../lib/keyless-bridge.mjs';

/** A mock OpencodeClient capturing the create/prompt/delete calls. */
function mockClient({ reply = 'VERDICT: clear', childId = 'ses_child' } = {}) {
  const calls = { create: [], prompt: [], delete: [] };
  return {
    calls,
    session: {
      create: async (req) => { calls.create.push(req); return { data: { id: childId } }; },
      prompt: async (req) => {
        calls.prompt.push(req);
        return { data: { info: { role: 'assistant' }, parts: [{ type: 'text', text: reply }] } };
      },
      delete: async (req) => { calls.delete.push(req); return { data: true }; },
    },
  };
}

test('answerFromPrompt: concatenates text parts, ignores non-text', () => {
  assert.equal(answerFromPrompt({ data: { parts: [{ type: 'text', text: 'a' }, { type: 'file' }, { type: 'text', text: 'b' }] } }), 'ab');
  assert.equal(answerFromPrompt({ data: { parts: [] } }), '');
  assert.equal(answerFromPrompt(null), '');
});

test('makeAsk: spins up a child session, prompts it, returns reply text, cleans up', async () => {
  const client = mockClient({ reply: 'VERDICT: SHIP', childId: 'ses_c1' });
  const ask = makeAsk(client, { parentID: 'ses_parent', model: { providerID: 'mock', modelID: 'm' } });
  assert.equal(typeof ask, 'function');
  const answer = await ask('audit this spec');
  assert.equal(answer, 'VERDICT: SHIP');
  // child parented to the active session
  assert.equal(client.calls.create[0].body.parentID, 'ses_parent');
  // prompted the child with the gate text, ALL tools denied (wildcard rule —
  // an empty map would inherit the base agent default = all enabled), chosen model
  assert.equal(client.calls.prompt[0].path.id, 'ses_c1');
  assert.deepEqual(client.calls.prompt[0].body.tools, { '*': false });
  assert.deepEqual(client.calls.prompt[0].body.model, { providerID: 'mock', modelID: 'm' });
  assert.equal(client.calls.prompt[0].body.parts[0].text, 'audit this spec');
  // child cleaned up
  assert.equal(client.calls.delete[0].path.id, 'ses_c1');
});

test('makeAsk: omits model when not given (inherit session default)', async () => {
  const client = mockClient();
  await makeAsk(client, { parentID: 'p' })('q');
  assert.equal('model' in client.calls.prompt[0].body, false);
});

test('makeAsk: teardown failure never fails the gate answer', async () => {
  const client = mockClient({ reply: 'ok' });
  client.session.delete = async () => { throw new Error('delete blew up'); };
  assert.equal(await makeAsk(client, {})('q'), 'ok');
});

test('makeAsk: no session API → null (caller fails closed)', () => {
  assert.equal(makeAsk({}, {}), null);
  assert.equal(makeAsk(null), null);
  assert.equal(makeAsk({ session: { create: () => {} } }), null); // create but no prompt
});

// ---- P5 finding: timeout + prompt cap (no hung turn / unbounded fan-out) ----
test('makeAsk: a hung child prompt times out and still deletes the child', async () => {
  const deletes = [];
  const client = {
    session: {
      create: async () => ({ data: { id: 'ses_hang' } }),
      prompt: () => new Promise(() => {}), // never resolves
      delete: async (req) => { deletes.push(req.path.id); },
    },
  };
  const ask = makeAsk(client, { timeoutMs: 20 });
  await assert.rejects(() => ask('q'), /timed out/);
  assert.deepEqual(deletes, ['ses_hang'], 'child cleaned up despite the hang');
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
  const client = mockClient({ reply: 'answer-A' });
  const ask = makeAsk(client, { parentID: 'p' });
  const spawnImpl = stubSpawn('single prompt block');
  const { answers } = await runGateKeyless({ bin: 'adlc', args: ['spec-lint'], ask, spawnImpl });
  assert.deepEqual(answers, ['answer-A']);
});
