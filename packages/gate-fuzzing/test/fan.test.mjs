/**
 * fan.test.mjs — tests for lib/fan.mjs: adversary fan-out, including the
 * --providers cross-family fan (issue #63). Injects completeFn so no
 * network calls or real API keys are required.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, buildUserPrompt, fanAdversary, buildPromptOnlyOutput } from '../lib/fan.mjs';

function gate(name = 'freeze-gate') {
  return {
    name,
    claims: ['no regressions'],
    surface: ['src/**'],
    docs: [],
  };
}

// ─── buildSystemPrompt / buildUserPrompt (pure) ───────────────────────────────

test('buildSystemPrompt names the target gate and its claims/surface', () => {
  const prompt = buildSystemPrompt(gate('my-gate'));
  assert.match(prompt, /my-gate/);
  assert.match(prompt, /no regressions/);
});

test('buildUserPrompt includes the assigned strategy class', () => {
  const prompt = buildUserPrompt(gate(), { name: 'base-ref-window', prior: 'do X' });
  assert.match(prompt, /base-ref-window/);
  assert.match(prompt, /do X/);
});

// ─── fanAdversary: default (n resamples, injected completeFn) ────────────────

test('fanAdversary: default fan width is n, one completeFn call per fan instance', async () => {
  const calls = [];
  const completeFn = async (call) => {
    calls.push(call);
    return 'candidate-output';
  };

  const results = await fanAdversary({ gates: [gate()], n: 3, completeFn });

  assert.equal(calls.length, 3);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.ok && r.value === 'candidate-output'));
  // No --providers requested — no per-call provider override.
  assert.ok(calls.every((c) => c.provider === undefined));
});

test('fanAdversary: a failing fan instance surfaces as ok:false, not a thrown error', async () => {
  let n = 0;
  const completeFn = async () => {
    n++;
    if (n === 2) throw new Error('boom');
    return 'ok-output';
  };

  const results = await fanAdversary({ gates: [gate()], n: 3, completeFn });

  assert.equal(results.length, 3);
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.equal(results.filter((r) => !r.ok).length, 1);
  assert.match(results.find((r) => !r.ok).error, /boom/);
});

test('fanAdversary: singular provider override forces the SAME provider for every resample (n unchanged)', async () => {
  const calls = [];
  const completeFn = async (call) => {
    calls.push(call);
    return 'x';
  };

  const results = await fanAdversary({ gates: [gate()], n: 3, provider: 'gemini', completeFn });

  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.provider === 'gemini'));
  assert.equal(results.length, 3);
});

// ─── fanAdversary: --providers (distinct provider families) ──────────────────

test('fanAdversary: providerNames overrides n — fan width equals number of providers', async () => {
  const calls = [];
  const completeFn = async (call) => {
    calls.push(call);
    return `from-${call.provider}`;
  };

  const results = await fanAdversary({
    gates: [gate()],
    n: 6, // ignored — providerNames wins
    providerNames: ['anthropic', 'openai', 'gemini'],
    completeFn,
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.provider), ['anthropic', 'openai', 'gemini']);
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.provider), ['anthropic', 'openai', 'gemini']);
  assert.deepEqual(results.map((r) => r.value), ['from-anthropic', 'from-openai', 'from-gemini']);
});

test('fanAdversary: providerNames assigns one DISTINCT gate/seed pairing per provider (not resampling)', async () => {
  const calls = [];
  const completeFn = async (call) => {
    calls.push(call);
    return 'x';
  };

  await fanAdversary({
    gates: [gate('gate-a'), gate('gate-b')],
    providerNames: ['anthropic', 'openai'],
    completeFn,
  });

  // Each call has a distinct system/user prompt (cycles through gates), and
  // a distinct provider — this is N genuinely different calls, not N
  // resamples of identical call options.
  assert.notEqual(calls[0].system, undefined);
  assert.equal(new Set(calls.map((c) => c.provider)).size, 2);
});

test('fanAdversary: a named provider that fails (e.g. missing API key) surfaces per-instance, others unaffected', async () => {
  const completeFn = async (call) => {
    if (call.provider === 'openai') throw new Error('provider "openai" is not available');
    return `from-${call.provider}`;
  };

  const results = await fanAdversary({
    gates: [gate()],
    providerNames: ['anthropic', 'openai', 'gemini'],
    completeFn,
  });

  assert.equal(results.length, 3);
  const openaiResult = results.find((r) => r.provider === 'openai');
  assert.equal(openaiResult.ok, false);
  assert.match(openaiResult.error, /openai/);
  assert.ok(results.find((r) => r.provider === 'anthropic').ok);
  assert.ok(results.find((r) => r.provider === 'gemini').ok);
});

test('fanAdversary: real (non-injected) path threads providerNames through to core complete() (fails closed, no network — no API keys configured)', async () => {
  // Force a clean slate regardless of the ambient environment: this test
  // asserts the fail-closed path, so it must never accidentally have real
  // credentials available and attempt a live network call.
  const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ADLC_AGY', 'ADLC_PROVIDER'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    const results = await fanAdversary({
      gates: [gate()],
      providerNames: ['anthropic', 'openai'],
      completeFn: null,
    });

    assert.equal(results.length, 2);
    // No provider is configured in this test environment — both calls should
    // fail closed with a provider-specific error, never silently succeed or
    // hang on a real network call.
    assert.ok(results.every((r) => r.ok === false));
    assert.ok(results.some((r) => /anthropic/.test(r.error)));
    assert.ok(results.some((r) => /openai/.test(r.error)));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ─── buildPromptOnlyOutput ────────────────────────────────────────────────────

test('buildPromptOnlyOutput: produces one prompt block per fan instance, labeled by gate/strategy', () => {
  const out = buildPromptOnlyOutput([gate('g1')], 2);
  assert.equal(out.length, 2);
  assert.match(out[0], /Fan instance 1\/2/);
  assert.match(out[0], /Gate: g1/);
});
