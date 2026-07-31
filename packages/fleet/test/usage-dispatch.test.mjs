// Concern: T152 P4 dispatch usage (operating-stack §8a) — adapter-specific
// parsing of each harness's own machine-readable output.
//
// Every payload here is a REAL captured harness document (test/fixtures/),
// pushed through the REAL adapter seam with a stub that emulates the production
// exec result shape. Two integrity rules the acceptance criteria impose:
//
//   1. The stub returns only what production `spawnAsync` returns —
//      status/stdout/stderr/signal. Injecting a synthetic `usage` property onto
//      the exec result would test a passthrough that does not exist.
//   2. The payloads are captured, not hand-written. A hand-authored "realistic"
//      document proves the parser handles the shape we IMAGINED the harness
//      emits, which is exactly the assumption worth testing.
//
// NOTE: the fleet's per-ticket gate-manifest RECORDING of this usage is not
// covered here. It is blocked on issue #418 — fleet records
// `gate: 'p4'`, which PHASE_BY_GATE does not map, so such an entry aggregates
// to 'unphased' rather than byPhase.P4. Asserting byPhase.P4 today would mean
// either editing spend.mjs (a T152 rail) or recording under a gate name that
// did not run. What IS provable now — that the adapters parse real harness
// output correctly and never fabricate — is proven here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter } from '../lib/adapters/index.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

/**
 * The plain-mode capture is stored JSON-escaped rather than raw: its bytes
 * include ANSI escapes (U+001B), and the repo forbids raw control characters in
 * tracked text files (issue #215, scripts/test/source-hygiene.test.mjs).
 * Parsing restores the exact captured bytes, so the fixture is still a real
 * capture — just spelled in a form the hygiene guard can accept.
 */
const plainCapture = () => JSON.parse(fixture('opencode-run-plain.json')).stdout;

/**
 * A stub shaped exactly like production `spawnAsync`'s return: no `usage`, no
 * convenience fields. `rec` captures the argv so a test can prove the adapter
 * actually asked its harness for machine-readable output.
 */
function stubExec(rec, { stdout = '', stderr = '', status = 0, signal = null } = {}) {
  return (cmd, args, opts) => {
    rec.push({ cmd, args, opts });
    return { status, stdout, stderr, signal };
  };
}

const ENV = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' };

function dispatchWith(adapterName, execResult) {
  const rec = [];
  return getAdapter(adapterName)
    .dispatch({ worktree: '/wt/T1', prompt: 'build T1', timeoutMs: 60000, env: ENV, exec: stubExec(rec, execResult) })
    .then((result) => ({ result, rec }));
}

describe('P4 dispatch usage — opencode (real `run --format json` capture)', () => {
  it('parses the captured event stream into exact counters, reported', async () => {
    const { result } = await dispatchWith('opencode', { stdout: fixture('opencode-run-json.jsonl') });

    // The fixture's own step_finish tokens: total 53461, input 53458, output 3.
    assert.equal(result.usageStatus, 'reported');
    assert.deepEqual(result.usage, { inputTokens: 53458, outputTokens: 3, cachedTokens: 0 });
    assert.equal(result.exitCode, 0);
  });

  it('folds additive reasoning tokens into outputTokens (the measurement the mapping rests on)', async () => {
    const { result } = await dispatchWith('opencode', { stdout: fixture('opencode-run-json-reasoning.jsonl') });

    // Captured from a real reasoning model: total 62845, input 62779,
    // output 42, reasoning 24. Note 62779 + 42 = 62821, NOT the total —
    // reasoning is ADDITIVE, so `total - input` is the only mapping that keeps
    // billed reasoning in the ledger.
    assert.equal(result.usage.inputTokens, 62779);
    assert.equal(result.usage.outputTokens, 66, 'total - input = 42 output + 24 reasoning');
    assert.equal(
      result.usage.outputTokens,
      result.usageRaw.output + result.usageRaw.reasoning,
      'the fold must equal the harness\'s own output+reasoning split'
    );
    assert.notEqual(result.usage.outputTokens, result.usageRaw.output, 'the naive mapping would drop 24 billed tokens');
  });

  it('preserves the harness token split verbatim for later backfill', async () => {
    const { result } = await dispatchWith('opencode', { stdout: fixture('opencode-run-json-reasoning.jsonl') });
    assert.deepEqual(result.usageRaw, {
      input: 62779, output: 42, reasoning: 24, cache: { read: 0, write: 0 }, total: 62845,
    });
  });

  it('asks the harness for machine-readable output at all', async () => {
    // Without this flag the harness emits decorated text and every dispatch
    // silently downgrades to unreported — a usage feature that reports nothing.
    const { rec } = await dispatchWith('opencode', { stdout: fixture('opencode-run-json.jsonl') });
    assert.deepEqual(rec[0].args.slice(0, 3), ['run', '--format', 'json']);
  });

  it('recovers the assistant text as output, not the raw event stream', async () => {
    const { result } = await dispatchWith('opencode', { stdout: fixture('opencode-run-json.jsonl') });
    assert.equal(result.output, 'ok', 'downstream consumers must still see what the worker said');
  });
});

describe('P4 dispatch usage — claude-code (real `-p --output-format json` capture)', () => {
  it('parses the captured result document into exact counters, reported', async () => {
    const { result } = await dispatchWith('claude-code', { stdout: fixture('claude-code-result.json') });

    // Fixture usage: input 10, output 54, cache_read 17615, cache_creation 21332.
    // Cache READ and CREATION both count as cached, matching core's
    // usageFromAnthropic — both are input the provider billed at a cache rate.
    assert.equal(result.usageStatus, 'reported');
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 54, cachedTokens: 38947 });
    assert.equal(38947, 17615 + 21332, 'cachedTokens is read + creation, not just read');
  });

  it('recovers the assistant text from the document result field', async () => {
    const { result } = await dispatchWith('claude-code', { stdout: fixture('claude-code-result.json') });
    assert.equal(result.output, 'ok');
  });

  it('asks the harness for json rather than text', async () => {
    const { rec } = await dispatchWith('claude-code', { stdout: fixture('claude-code-result.json') });
    const i = rec[0].args.indexOf('--output-format');
    assert.notEqual(i, -1, 'the format flag must be present');
    assert.equal(rec[0].args[i + 1], 'json');
  });
});

describe('P4 dispatch usage — the no-fabrication rule', () => {
  // Each case must yield NO usage key and 'unreported' — never a zeroed object,
  // which would book an unmeasured call as a measured free one, and never an
  // error, which would turn an unparseable transcript into a failed build.
  const UNPARSEABLE = {
    'real plain-text output (no machine-readable mode)': plainCapture,
    'empty stdout': () => '',
    'truncated json': () => '{"type":"result","usage":{"input_tok',
    'valid json with no usage block': () => '{"type":"result","result":"ok"}',
    'a counter that is not a clean count': () => '{"type":"result","usage":{"input_tokens":-1,"output_tokens":5}}',
    'a float counter': () => '{"type":"result","usage":{"input_tokens":1.5,"output_tokens":5}}',
  };

  for (const [label, payload] of Object.entries(UNPARSEABLE)) {
    it(`claude-code: ${label} records unreported without error`, async () => {
      const { result } = await dispatchWith('claude-code', { stdout: payload() });
      assert.equal(result.usageStatus, 'unreported');
      assert.equal('usage' in result, false, 'no usage key — a zeroed object would read as a measured free call');
      assert.equal(result.exitCode, 0, 'an unparseable transcript is not a build failure');
    });
  }

  it('opencode: a step_finish whose totals are incoherent is unreported, not negative', async () => {
    // total < input would yield a NEGATIVE outputTokens, silently corrupting
    // every downstream sum. Rejecting the whole block is the only safe answer.
    const { result } = await dispatchWith('opencode', {
      stdout: '{"type":"step_finish","part":{"tokens":{"total":5,"input":9,"cache":{"read":0,"write":0}}}}',
    });
    assert.equal(result.usageStatus, 'unreported');
    assert.equal('usage' in result, false);
  });

  it('opencode: plain-text stdout falls back to the raw output rather than an empty transcript', async () => {
    const plain = plainCapture();
    const { result } = await dispatchWith('opencode', { stdout: plain });
    assert.equal(result.usageStatus, 'unreported');
    assert.equal(result.output, plain, 'no events parsed means keep everything the harness printed');
  });
});

describe('P4 dispatch usage — test integrity', () => {
  it('the exec stub carries no usage property, so nothing can pass through it', () => {
    // Guards the AC directly: production spawnAsync returns only
    // status/signal/stdout/stderr/error/timedOut. If a future refactor started
    // reading `res.usage`, these tests must NOT be the thing that makes it pass.
    const rec = [];
    const res = stubExec(rec, { stdout: 'x' })('cmd', [], {});
    assert.deepEqual(Object.keys(res).sort(), ['signal', 'status', 'stderr', 'stdout']);
    assert.equal('usage' in res, false);
  });

  it('every usage-reporting adapter derives usage from stdout alone', async () => {
    // Same captured payload delivered on stdout parses; delivered as an
    // out-of-band property it must be invisible.
    for (const [adapterName, name] of [['opencode', 'opencode-run-json.jsonl'], ['claude-code', 'claude-code-result.json']]) {
      const viaStdout = await dispatchWith(adapterName, { stdout: fixture(name) });
      assert.equal(viaStdout.result.usageStatus, 'reported', `${adapterName}: parses from stdout`);

      const rec = [];
      const smuggled = await getAdapter(adapterName).dispatch({
        worktree: '/wt', prompt: 'p', timeoutMs: 1, env: ENV,
        exec: (cmd, args, opts) => { rec.push({ cmd, args, opts }); return { status: 0, stdout: '', stderr: '', signal: null, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 1 } }; },
      });
      assert.equal(smuggled.usageStatus, 'unreported', `${adapterName}: must ignore a usage property on the exec result`);
      assert.equal('usage' in smuggled, false);
    }
  });
});

// ---- the recording seam: parsed usage reaching the gate-manifest entry ----
//
// These drive the REAL scheduler (advanceTicket) and the REAL recordGate
// wiring, with the dispatch result shaped exactly as the adapters above
// produce it. What they do NOT assert is `aggregate.byPhase.P4`: the fleet
// records `gate: 'p4'`, which PHASE_BY_GATE does not map, so such an entry
// aggregates to 'unphased'. That two-line mapping change is
// issue #418, which cannot land until T152 completes and its
// spend.mjs rail expires. Flipping these assertions to byPhase.P4 is that
// ticket's final step.

import { advanceTicket } from '../lib/scheduler.mjs';
import { usageEvidence } from '../lib/adapters/usage.mjs';

const TICKET = { id: 'T1', title: 't', scope: [], rails: [], edges: [] };
const okGate = () => ({ ok: true });
const passProsecute = () => ({ verdict: 'pass' });
const okMerge = () => ({ ok: true });
const noFlail = () => ({ flail: false });

function spy() {
  const calls = { usage: [], verdicts: [] };
  return {
    calls,
    effects: {
      gate: okGate, prosecute: passProsecute, merge: okMerge, flail: noFlail,
      record: (phase, ok, data) => calls.verdicts.push({ phase, ok, data }),
      recordDispatchUsage: (d) => { const e = usageEvidence(d); if (e) calls.usage.push(e); },
    },
  };
}


describe('P4 recording seam — one carrier per DISPATCH, not per verdict', () => {
  it('books the dispatch spend as reported', async () => {
    const { calls, effects } = spy();
    const usage = { inputTokens: 53458, outputTokens: 3, cachedTokens: 0 };
    await advanceTicket(TICKET, {
      ...effects,
      dispatch: () => ({ exitCode: 0, timedOut: false, output: 'done', usage, usageStatus: 'reported' }),
    });

    assert.equal(calls.usage.length, 1);
    assert.deepEqual(calls.usage[0], { usageStatus: 'reported', usage });
  });

  it('records unreported WITHOUT a usage key when the harness said nothing', async () => {
    const { calls, effects } = spy();
    await advanceTicket(TICKET, {
      ...effects,
      dispatch: () => ({ exitCode: 0, timedOut: false, output: 'done', usageStatus: 'unreported' }),
    });
    assert.equal(calls.usage[0].usageStatus, 'unreported');
    assert.equal('usage' in calls.usage[0], false);
  });

  it('the gate-verdict entry no longer carries usage — one call is booked once', async () => {
    const { calls, effects } = spy();
    await advanceTicket(TICKET, {
      ...effects,
      dispatch: () => ({ exitCode: 0, timedOut: false, output: 'done', usage: { inputTokens: 5, outputTokens: 1, cachedTokens: 0 }, usageStatus: 'reported' }),
    });
    const carriers = calls.verdicts.filter((c) => c.data?.usage);
    assert.equal(carriers.length, 0, 'usage on both entries would double-count the call');
    assert.equal(calls.usage.length, 1);
  });

  // The regressions the adversarial review named: spend on paths that never
  // reach a gate verdict used to vanish entirely.
  it('books a FAILED strike as well as the repair strike (no hidden spend)', async () => {
    const { calls, effects } = spy();
    let n = 0;
    await advanceTicket(TICKET, {
      ...effects,
      dispatch: () => {
        n += 1;
        return { exitCode: 0, timedOut: false, output: 'x', usage: { inputTokens: n === 1 ? 100_000 : 20_000, outputTokens: n, cachedTokens: 0 }, usageStatus: 'reported' };
      },
      gate: () => (n === 1 ? { ok: false, output: 'gate boom' } : { ok: true }),
    });

    assert.equal(calls.usage.length, 2, 'two dispatches means two calls');
    const total = calls.usage.reduce((s, d) => s + d.usage.inputTokens, 0);
    assert.equal(total, 120_000, 'the 100k first strike must not be hidden by the 20k repair');
  });

  it('books a BLOCKED build, which returns before any verdict', async () => {
    const { calls, effects } = spy();
    const r = await advanceTicket(TICKET, {
      ...effects,
      dispatch: () => ({ exitCode: 0, timedOut: false, blocked: true, output: 'TICKET-BLOCKED', usage: { inputTokens: 7000, outputTokens: 5, cachedTokens: 0 }, usageStatus: 'reported' }),
    });
    assert.equal(r.state, 'blocked');
    assert.equal(calls.usage.length, 1, 'a blocked worker still spent real tokens');
    assert.equal(calls.usage[0].usage.inputTokens, 7000);
  });

  it('books a FLAIL-terminated strike, which also returns before any verdict', async () => {
    const { calls, effects } = spy();
    const r = await advanceTicket(TICKET, {
      ...effects,
      dispatch: () => ({ exitCode: 1, timedOut: false, output: 'boom', usage: { inputTokens: 9000, outputTokens: 3, cachedTokens: 0 }, usageStatus: 'reported' }),
      flail: () => ({ flail: true }),
    });
    assert.equal(r.state, 'failed');
    assert.equal(calls.usage.length, 1);
    assert.equal(calls.usage[0].usage.inputTokens, 9000);
  });

  it('usageEvidence never invents a status for a dispatch that did not happen', () => {
    assert.equal(usageEvidence(null), undefined);
    assert.equal(usageEvidence(undefined), undefined);
    assert.deepEqual(usageEvidence({ exitCode: 0 }), { usageStatus: 'unreported' });
  });
});

describe('P4 dispatch usage — cache accounting is derived, never assumed', () => {
  // Four real captures across two models all report cache 0/0, which is
  // consistent with cache being counted INSIDE `input` and with it being
  // counted outside. The parser therefore asks the payload which identity it
  // satisfies rather than hard-coding one.
  const step = (tokens) => JSON.stringify({ type: 'step_finish', part: { tokens } });

  it('cache INSIDE input: outputTokens is the plain remainder', async () => {
    // 10 + 2 + 3 == 15 == total, so cache is already accounted for in input.
    const { result } = await dispatchWith('opencode', {
      stdout: step({ total: 15, input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 1 } }),
    });
    assert.equal(result.usageStatus, 'reported');
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, cachedTokens: 5 });
  });

  it('cache OUTSIDE input: cache is not also booked as generated output', async () => {
    // 10 + 2 + 3 + 150 == 165 == total. A plain `total - input` would report
    // outputTokens 155 — folding all 150 cached tokens into generated output
    // AND counting them again as cachedTokens, then pricing them at the output
    // rate. The correct generated figure is 5.
    const { result } = await dispatchWith('opencode', {
      stdout: step({ total: 165, input: 10, output: 2, reasoning: 3, cache: { read: 100, write: 50 } }),
    });
    assert.equal(result.usageStatus, 'reported');
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, cachedTokens: 150 });
    assert.notEqual(result.usage.outputTokens, 155, 'the double-count must not reappear');
  });

  it('an accounting matching NEITHER identity is unreported, not mis-booked', async () => {
    const { result } = await dispatchWith('opencode', {
      stdout: step({ total: 999, input: 10, output: 2, reasoning: 3, cache: { read: 1, write: 1 } }),
    });
    assert.equal(result.usageStatus, 'unreported');
    assert.equal('usage' in result, false);
  });

  it('a partial token block is unreported, never assembled from zeros', async () => {
    // Defaulting missing counters to 0 would certify `tokens: {}` as a measured
    // FREE call — collapsing unknown into free, the exact no-fabrication failure.
    for (const tokens of [{}, { total: 15, input: 10 }, { total: 15, input: 10, output: 2, reasoning: 3 }, { total: 15, input: 10, output: 2, reasoning: 3, cache: { read: 1 } }]) {
      const { result } = await dispatchWith('opencode', { stdout: step(tokens) });
      assert.equal(result.usageStatus, 'unreported', `partial block ${JSON.stringify(tokens)} must not report`);
      assert.equal('usage' in result, false);
    }
  });

  it('the real captures still parse — the stricter rule did not break them', async () => {
    for (const name of ['opencode-run-json.jsonl', 'opencode-run-json-reasoning.jsonl']) {
      const { result } = await dispatchWith('opencode', { stdout: fixture(name) });
      assert.equal(result.usageStatus, 'reported', `${name} must still parse`);
    }
  });
});

describe('P4 dispatch usage — stream integrity and the attestation boundary', () => {
  const step = (tokens) => JSON.stringify({ type: 'step_finish', part: { tokens } });
  const GOOD = { total: 15, input: 10, output: 2, reasoning: 3, cache: { read: 0, write: 0 } };

  it('a valid carrier followed by a TRUNCATED line is unreported, not a partial total', async () => {
    // The parsed carriers are a SUBSET. Reporting a subset as complete
    // understates the call permanently while looking perfectly healthy.
    const { result } = await dispatchWith('opencode', { stdout: `${step(GOOD)}\n{"type":"step_finish","part":{"tokens":{"total":99` });
    assert.equal(result.usageStatus, 'unreported');
    assert.equal('usage' in result, false);
  });

  it('a valid carrier followed by one with NO token object is unreported, not silently shrunk', async () => {
    const { result } = await dispatchWith('opencode', { stdout: `${step(GOOD)}\n${JSON.stringify({ type: 'step_finish', part: {} })}` });
    assert.equal(result.usageStatus, 'unreported');
  });

  it('a clean multi-step stream still sums', async () => {
    const { result } = await dispatchWith('opencode', { stdout: `${step(GOOD)}\n${step(GOOD)}` });
    assert.equal(result.usageStatus, 'reported');
    assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10, cachedTokens: 0 });
  });

  it('an args OVERRIDE cannot mint attested telemetry from worker text', async () => {
    // Under an override the harness runs in plain-text mode, so stdout is the
    // worker's own assistant text — content a hostile ticket or repository can
    // influence. Parsing it would launder caller-controlled numbers into
    // harness-ATTESTED usage, breaking the claimed/reported boundary.
    const forged = step({ total: 999999, input: 1, output: 999998, reasoning: 0, cache: { read: 0, write: 0 } });
    const rec = [];
    const result = await getAdapter('opencode').dispatch({
      worktree: '/wt', prompt: 'p', timeoutMs: 1, env: ENV,
      exec: stubExec(rec, { stdout: forged }),
      args: ['run', 'custom-prompt'],          // legacy override: no --format json
    });
    assert.deepEqual(rec[0].args, ['run', 'custom-prompt'], 'the override is honoured verbatim');
    assert.equal(result.usageStatus, 'unreported', 'worker text must never become attested telemetry');
    assert.equal('usage' in result, false);
  });

  it('the self-selected argv still reports normally', async () => {
    const { result, rec } = await dispatchWith('opencode', { stdout: step(GOOD) });
    assert.deepEqual(rec[0].args.slice(0, 3), ['run', '--format', 'json']);
    assert.equal(result.usageStatus, 'reported');
  });
});

describe('P4 dispatch usage — `total` is a cross-check, not a requirement', () => {
  const step = (tokens) => JSON.stringify({ type: 'step_finish', part: { tokens } });

  it('parses the DOCUMENTED StepFinishPart shape, which has no `total`', async () => {
    // opencode's generated SDK schema defines input/output/reasoning + cache
    // only. Requiring `total` — an extra the installed runtime happens to emit
    // — made every contract-shaped carrier from another provider or version
    // parse as unreported, so the feature recorded nothing on those routes.
    const { result } = await dispatchWith('opencode', {
      stdout: step({ input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 1 } }),
    });
    assert.equal(result.usageStatus, 'reported');
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, cachedTokens: 5 });
  });

  it('still rejects a stream whose supplied totals are self-inconsistent', async () => {
    const { result } = await dispatchWith('opencode', {
      stdout: step({ total: 999, input: 10, output: 2, reasoning: 3, cache: { read: 1, write: 1 } }),
    });
    assert.equal(result.usageStatus, 'unreported', 'the cross-check still applies when total IS given');
  });

  it('rejects a malformed `total` rather than ignoring it', async () => {
    const { result } = await dispatchWith('opencode', {
      stdout: step({ total: -1, input: 10, output: 2, reasoning: 3, cache: { read: 0, write: 0 } }),
    });
    assert.equal(result.usageStatus, 'unreported');
  });

  it('the real captures — which DO carry total — are unchanged', async () => {
    const a = await dispatchWith('opencode', { stdout: fixture('opencode-run-json.jsonl') });
    assert.deepEqual(a.result.usage, { inputTokens: 53458, outputTokens: 3, cachedTokens: 0 });
    const b = await dispatchWith('opencode', { stdout: fixture('opencode-run-json-reasoning.jsonl') });
    assert.deepEqual(b.result.usage, { inputTokens: 62779, outputTokens: 66, cachedTokens: 0 });
  });
});

describe('P4 dispatch usage — degenerate JSON documents', () => {
  // `JSON.parse` happily yields null and scalars. `typeof null === 'object'`,
  // so the null case is the ONLY input that separates a correct document guard
  // from one that reads `.usage` off null and throws — a harness emitting a
  // bare `null` must downgrade the call, never crash the dispatch.
  const DEGENERATE = { 'literal null': 'null', 'a bare number': '5', 'a bare string': '"ok"', 'a bare array': '[]', 'a bare boolean': 'true' };

  for (const [label, stdout] of Object.entries(DEGENERATE)) {
    it(`claude-code: ${label} is unreported, and does not throw`, async () => {
      const { result } = await dispatchWith('claude-code', { stdout });
      assert.equal(result.usageStatus, 'unreported');
      assert.equal('usage' in result, false);
      assert.equal(result.exitCode, 0, 'a degenerate document is not a build failure');
    });
  }
});
