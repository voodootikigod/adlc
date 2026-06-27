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

test('runGateKeyless: asks each prompt in order, threads prior answers', () => {
  const spawnImpl = stubSpawn('--- prompt 1 of 2 ---\nA\n--- prompt 2 of 2 ---\nB');
  const seen = [];
  const ask = (text, ctx) => { seen.push({ text, prior: ctx.prior.length }); return `ans:${text}`; };
  const { prompts, answers } = runGateKeyless({ bin: 'adlc', args: ['parallax'], ask, spawnImpl });
  assert.equal(prompts.length, 2);
  assert.deepEqual(answers, ['ans:A', 'ans:B']);
  assert.deepEqual(seen.map((s) => s.prior), [0, 1]); // 2nd ask sees 1 prior answer
});

test('runGateKeyless: gate operational failure (status!=0) throws', () => {
  const spawnImpl = stubSpawn('', 1, 'no provider');
  assert.throws(() => runGateKeyless({ bin: 'adlc', args: ['spec-lint'], ask: () => 'x', spawnImpl }), /exited 1/);
});

test('runGateKeyless: requires an ask function', () => {
  assert.throws(() => runGateKeyless({ bin: 'adlc', spawnImpl: stubSpawn('p') }), /ask\(prompt\) function is required/);
});

// ---- makeAsk capability resolution (plan §6.4) ----
test('makeAsk: uses the SDK isolated-prompt extension when present', () => {
  const calls = [];
  const api = { client: { prompt: (o) => { calls.push(o); return 'iso'; } } };
  const ask = makeAsk(api);
  assert.equal(typeof ask, 'function');
  assert.equal(ask('hello', { index: 1 }), 'iso');
  assert.equal(calls[0].isolated, true);
});

test('makeAsk: degrades to the active session model only when allowed', () => {
  const api = { client: { session: { prompt: () => 'active' } } };
  assert.equal(makeAsk(api, { allowDegraded: false }), null, 'no silent degrade by default');
  const ask = makeAsk(api, { allowDegraded: true });
  assert.equal(ask('x', {}), 'active');
});

test('makeAsk: no capability + not allowed → null (caller fails closed)', () => {
  assert.equal(makeAsk({}, {}), null);
  assert.equal(makeAsk(null, { allowDegraded: true }), null);
});
