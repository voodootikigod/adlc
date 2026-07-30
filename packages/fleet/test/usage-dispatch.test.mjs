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
// covered here. It is blocked on T-01KYSNGQB4W8CTX16FMD6QAK67 — fleet records
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
    'real plain-text output (no machine-readable mode)': () => fixture('opencode-run-plain.txt'),
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
    const plain = fixture('opencode-run-plain.txt');
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
