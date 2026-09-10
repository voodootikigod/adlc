// fan-integrity.test.mjs — issues #705, #706, #709.
//
// Three false-greens that all end the same way: parallax prints `gate PASSES ✓`
// and exits 0 having measured nothing.
//
//   #705  an off-schema divergence payload (a refusal object, a truncated `{}`,
//         a bare array, a `{result: …}` wrapper) hit the `?? []` defaults, so
//         computeScore(0, 0) returned 0, 0 <= 0.25, and the gate passed. With
//         --questions-json that became `{questions: [], gate: true}`, which a
//         P1 interrogation loop reads as "empty frontier — stop asking".
//   #706  the fan's only floor was an absolute `readings.length < 2`, never
//         relative to --n, so 2 of 5 requested readings still produced a full
//         verdict — and a narrowed sample scores systematically LOWER, i.e. it
//         biases toward exit 0. `--n 1` was accepted but could never satisfy
//         the >=2 guard, spending an API call to reach a guaranteed exit 1.
//   #709  --record-verdict wrote a manifest entry with no ticket binding, so
//         the evidence could satisfy any ticket's P1 gate.
//
// The pure validators are tested directly AND through runDivergenceAnalysis /
// runRouteMode (via the deps seam) AND end-to-end through the bin (via the
// NODE_ENV=test-gated ADLC_GATE_MOCK_RESPONSE seam), because a test that only
// exercises the pure predicate cannot tell whether the orchestrator still calls
// it, and a test that only exercises the orchestrator cannot tell whether the
// CLI still threads the flag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  divergencePayloadError,
  fanWidthError,
  resolveDeps,
  runDivergenceAnalysis,
  runSpecMode,
  runRouteMode,
} from '../lib/modes.mjs';

const BIN = new URL('../bin/parallax.mjs', import.meta.url).pathname;
const NODE = process.execPath;

/** A well-formed fan reading, as the cheap readers are asked to emit. */
function reading(spec) {
  return { spec, assumptions: [], decisions: [] };
}

/** fan() result shapes: `ok` entries carry JSON text, failures carry an error. */
function okResult(value) {
  return { ok: true, value: JSON.stringify(value) };
}
function failResult(error) {
  return { ok: false, error };
}

/**
 * Build a `deps` seam for runDivergenceAnalysis / runRouteMode.
 * `fanResults` is returned verbatim (the caller decides how many succeeded);
 * `completeValue` is what the single divergence/judge call resolves to.
 */
function stubDeps({ fanResults = [], completeValue = '{}' } = {}) {
  const calls = { fan: 0, complete: 0 };
  return {
    calls,
    deps: {
      async fan() {
        calls.fan += 1;
        return fanResults;
      },
      async complete() {
        calls.complete += 1;
        return typeof completeValue === 'string' ? completeValue : JSON.stringify(completeValue);
      },
    },
  };
}

function run(args, opts = {}) {
  return spawnSync(NODE, [BIN, ...args], { encoding: 'utf8', timeout: 20000, ...opts });
}

/**
 * Spawn the bin with the mock LLM seam armed. The seam is honored ONLY when
 * NODE_ENV === 'test' — `runMockedWithoutTestEnv` below proves the other half.
 */
function runMocked(args, mock, opts = {}) {
  return run(args, {
    ...opts,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ADLC_GATE_MOCK_RESPONSE: typeof mock === 'string' ? mock : JSON.stringify(mock),
    },
  });
}

const TWO_GOOD_READINGS = [okResult(reading('A')), okResult(reading('B'))];
const CONVERGED = { agreements: ['both agree'], divergences: [] };

// ---------------------------------------------------------------------------
// AC1 / AC3 — divergencePayloadError: the single, pure schema predicate
// ---------------------------------------------------------------------------

test('AC3: divergencePayloadError is exported and returns null for a well-formed payload', () => {
  assert.equal(typeof divergencePayloadError, 'function');
  assert.equal(divergencePayloadError({ agreements: [], divergences: [] }), null);
  assert.equal(divergencePayloadError({ agreements: ['a'], divergences: [{ point: 'p', options: [] }] }), null);
});

test('AC1: an off-schema divergence payload is rejected with a reason naming the expected shape', () => {
  const offSchema = [
    ['truncated object', {}],
    ['bare array', []],
    ['refusal object', { error: 'I cannot comply with that request' }],
    ['wrapper object', { result: {} }],
    ['null', null],
    ['undefined', undefined],
    ['string', 'not an object'],
    ['number', 7],
    ['agreements only', { agreements: [] }],
    ['divergences only', { divergences: [] }],
    ['agreements not an array', { agreements: 'none', divergences: [] }],
    ['divergences not an array', { agreements: [], divergences: 'none' }],
  ];
  for (const [label, payload] of offSchema) {
    const reason = divergencePayloadError(payload);
    assert.equal(typeof reason, 'string', `${label} must be rejected, got ${reason}`);
    assert.match(reason, /agreements/, `${label}: reason must name the expected shape`);
    assert.match(reason, /divergences/, `${label}: reason must name the expected shape`);
  }
});

test('AC3: divergencePayloadError is pure — no mutation, stable across calls', () => {
  const payload = { agreements: [], divergences: [] };
  const before = JSON.stringify(payload);
  assert.equal(divergencePayloadError(payload), null);
  assert.equal(divergencePayloadError(payload), null);
  assert.equal(JSON.stringify(payload), before, 'input must not be mutated');

  const bad = { error: 'refused' };
  const first = divergencePayloadError(bad);
  assert.equal(divergencePayloadError(bad), first, 'same input must give the same reason');
  assert.equal(JSON.stringify(bad), '{"error":"refused"}', 'input must not be mutated');
});

// ---------------------------------------------------------------------------
// AC4 — fanWidthError: the single, pure fan-width predicate
// ---------------------------------------------------------------------------

test('AC4: fanWidthError refuses a shrunken fan and names used-of-requested', () => {
  const reason = fanWidthError({ requested: 5, used: 2, errors: ['rate limit', 'timeout', 'parse error'] });
  assert.equal(typeof reason, 'string');
  assert.match(reason, /2/);
  assert.match(reason, /5/);
  assert.match(reason, /--allow-partial-fan/, 'the reason must name the opt-out');
  assert.match(reason, /rate limit/, 'the reason must carry the underlying errors');
});

test('AC4: fanWidthError allows a full fan, and allows a shrunken one only with the opt-in', () => {
  assert.equal(fanWidthError({ requested: 3, used: 3, errors: [] }), null);
  assert.equal(fanWidthError({ requested: 5, used: 2, errors: ['x'], allowPartialFan: true }), null);
  assert.equal(fanWidthError({ requested: 5, used: 5, errors: [], allowPartialFan: true }), null);
});

test('AC4: fanWidthError is pure — no mutation, stable across calls', () => {
  const args = { requested: 4, used: 2, errors: ['a'] };
  const first = fanWidthError(args);
  assert.equal(fanWidthError(args), first);
  assert.deepEqual(args, { requested: 4, used: 2, errors: ['a'] });
});

// ---------------------------------------------------------------------------
// AC1 / AC2 / AC4 — the orchestrator actually calls those predicates
// ---------------------------------------------------------------------------

test('AC1: runDivergenceAnalysis throws on an off-schema divergence payload instead of scoring 0', async () => {
  for (const payload of ['{}', '[]', '{"error":"refused"}', '{"result":{}}']) {
    const { deps } = stubDeps({ fanResults: TWO_GOOD_READINGS, completeValue: payload });
    await assert.rejects(
      () => runDivergenceAnalysis('prompt', { n: 2, deps }),
      (err) => {
        assert.match(err.message, /agreements/);
        assert.match(err.message, /divergences/);
        return true;
      },
      `payload ${payload} must be refused, not scored`
    );
  }
});

test('AC2: a well-formed payload with empty-but-present arrays still scores 0 and does not throw', async () => {
  const { deps } = stubDeps({
    fanResults: TWO_GOOD_READINGS,
    completeValue: { agreements: [], divergences: [] },
  });
  const result = await runDivergenceAnalysis('prompt', { n: 2, deps });
  assert.equal(result.score, 0, 'a genuine convergence is not an error');
  assert.deepEqual(result.agreements, []);
  assert.deepEqual(result.divergences, []);
});

test('AC2: a converged payload with agreements scores 0 and reports the agreements', async () => {
  const { deps } = stubDeps({ fanResults: TWO_GOOD_READINGS, completeValue: CONVERGED });
  const result = await runDivergenceAnalysis('prompt', { n: 2, deps });
  assert.equal(result.score, 0);
  assert.deepEqual(result.agreements, ['both agree']);
});

test('AC4: runDivergenceAnalysis reports requested and used on the happy path', async () => {
  const { deps } = stubDeps({ fanResults: TWO_GOOD_READINGS, completeValue: CONVERGED });
  const result = await runDivergenceAnalysis('prompt', { n: 2, deps });
  assert.equal(result.requested, 2);
  assert.equal(result.used, 2);
});

test('AC4: runDivergenceAnalysis refuses a verdict when the fan shrank, naming 2 of 5', async () => {
  const fanResults = [
    okResult(reading('A')),
    okResult(reading('B')),
    failResult('rate limit'),
    failResult('timeout'),
    { ok: true, value: 'not json at all' },
  ];
  const { deps, calls } = stubDeps({ fanResults, completeValue: CONVERGED });
  await assert.rejects(
    () => runDivergenceAnalysis('prompt', { n: 5, deps }),
    (err) => {
      assert.match(err.message, /2/);
      assert.match(err.message, /5/);
      assert.match(err.message, /--allow-partial-fan/);
      return true;
    }
  );
  assert.equal(calls.complete, 0, 'the mid-tier divergence call must not be spent on a refused fan');
});

test('AC4: --allow-partial-fan accepts the narrowed sample and reports requested/used', async () => {
  const fanResults = [
    okResult(reading('A')),
    okResult(reading('B')),
    failResult('rate limit'),
    failResult('timeout'),
    failResult('parse error'),
  ];
  const { deps } = stubDeps({ fanResults, completeValue: CONVERGED });
  const result = await runDivergenceAnalysis('prompt', { n: 5, deps, allowPartialFan: true });
  assert.equal(result.requested, 5);
  assert.equal(result.used, 2);
  assert.equal(result.errors.length, 3, 'the failures are still reported as warnings');
});

test('regression: the absolute >=2 floor still applies even with --allow-partial-fan', async () => {
  const { deps } = stubDeps({
    fanResults: [okResult(reading('A')), failResult('down'), failResult('down')],
    completeValue: CONVERGED,
  });
  await assert.rejects(
    () => runDivergenceAnalysis('prompt', { n: 3, deps, allowPartialFan: true }),
    /at least 2 successful readings/
  );
});

test('runSpecMode forwards the fan-width and payload guards', async () => {
  const { deps } = stubDeps({
    fanResults: [okResult(reading('A')), okResult(reading('B')), failResult('down')],
    completeValue: CONVERGED,
  });
  await assert.rejects(() => runSpecMode('a request', { n: 3, deps }), /--allow-partial-fan/);
});

test('AC4: runRouteMode refuses a shrunken fan and reports requested/used when allowed', async () => {
  const fanResults = [
    { ok: true, value: 'Use PostgreSQL' },
    { ok: true, value: 'PostgreSQL' },
    { ok: false, error: 'timeout' },
  ];
  const judge = { equivalent: true, answer: 'PostgreSQL', variants: [] };

  const refused = stubDeps({ fanResults, completeValue: judge });
  await assert.rejects(
    () => runRouteMode('Which database?', [], { n: 3, deps: refused.deps }),
    /--allow-partial-fan/
  );
  assert.equal(refused.calls.complete, 0, 'the judge call must not be spent on a refused fan');

  const allowed = stubDeps({ fanResults, completeValue: judge });
  const result = await runRouteMode('Which database?', [], {
    n: 3,
    deps: allowed.deps,
    allowPartialFan: true,
  });
  assert.equal(result.requested, 3);
  assert.equal(result.used, 2);
  assert.equal(result.equivalent, true);
});


// ---------------------------------------------------------------------------
// The refusal message has to say what it actually got — an operator reading
// "off-schema payload" with no shape named cannot tell a refusal apart from a
// truncation.
// ---------------------------------------------------------------------------

test('the off-schema reason names the shape that was actually returned', () => {
  assert.match(divergencePayloadError(null), /got null/);
  assert.match(divergencePayloadError([]), /got an array/);
  assert.match(divergencePayloadError('refused'), /got string/);
  assert.match(divergencePayloadError(7), /got number/);
  assert.match(divergencePayloadError({ agreements: [] }), /divergences missing or not an array/);
  assert.match(divergencePayloadError({ divergences: [] }), /agreements missing or not an array/);
  assert.match(
    divergencePayloadError({}),
    /agreements and divergences missing or not an array/
  );
});

test('fanWidthError carries the failures even when there is only one', () => {
  const one = fanWidthError({ requested: 3, used: 2, errors: ['rate limit'] });
  assert.match(one, /Errors: rate limit/, 'a single failure must still be reported');

  const none = fanWidthError({ requested: 3, used: 2, errors: [] });
  assert.ok(!none.includes('Errors:'), 'no failures → no empty Errors suffix');
});

// ---------------------------------------------------------------------------
// resolveDeps — the seam must default to the real callables and must not
// accept a half-supplied injection.
// ---------------------------------------------------------------------------

test('resolveDeps returns real callables when nothing is injected and no mock is armed', () => {
  const resolved = resolveDeps(undefined, {});
  assert.equal(typeof resolved.fan, 'function');
  assert.equal(typeof resolved.complete, 'function');
});

test('resolveDeps ignores a half-supplied deps object rather than returning it', () => {
  const onlyFan = async () => [];
  const resolvedFan = resolveDeps({ fan: onlyFan }, {});
  assert.notEqual(resolvedFan.fan, onlyFan, 'a deps object without complete must not be used');
  assert.equal(typeof resolvedFan.complete, 'function');

  const onlyComplete = async () => '{}';
  const resolvedComplete = resolveDeps({ complete: onlyComplete }, {});
  assert.notEqual(resolvedComplete.complete, onlyComplete, 'a deps object without fan must not be used');

  const both = { fan: onlyFan, complete: onlyComplete };
  assert.equal(resolveDeps(both, {}), both, 'a complete deps pair is used as given');
});

test('resolveDeps ignores the mock unless NODE_ENV is test', () => {
  const armed = JSON.stringify({ fan: TWO_GOOD_READINGS, divergence: CONVERGED });
  const ignored = resolveDeps(undefined, { ADLC_GATE_MOCK_RESPONSE: armed, NODE_ENV: 'production' });
  assert.equal(typeof ignored.fan, 'function');
  // The real fan is used, so the mock payload is not reachable through it.
  const honored = resolveDeps(undefined, { ADLC_GATE_MOCK_RESPONSE: armed, NODE_ENV: 'test' });
  assert.notEqual(honored.fan, ignored.fan);
});

test('a shape-deviant mock is refused with a message naming the expected object', () => {
  for (const [raw, pattern] of [
    ['"hello"', /must be an object/],
    ['[]', /must be an object/],
    ['null', /must be an object/],
    ['{"divergence":{}}', /fan must be an array/],
    ['{"fan":"nope","divergence":{}}', /fan must be an array/],
    ['{"fan":[]}', /divergence.*judge/],
  ]) {
    assert.throws(
      () => resolveDeps(undefined, { ADLC_GATE_MOCK_RESPONSE: raw, NODE_ENV: 'test' }),
      pattern,
      `mock ${raw} must fail closed`
    );
  }
});

// ---------------------------------------------------------------------------
// The documented default fan width is 3 in every mode — the CLI default and
// the library default must not drift apart.
// ---------------------------------------------------------------------------

test('the library default fan width is 3 for divergence modes', async () => {
  const fanResults = [okResult(reading('A')), okResult(reading('B')), okResult(reading('C'))];
  const { deps } = stubDeps({ fanResults, completeValue: CONVERGED });
  const result = await runSpecMode('a request', { deps });
  assert.equal(result.requested, 3, 'omitting n must request the documented default of 3');
  assert.equal(result.used, 3);
});

test('the library default fan width is 3 for route mode', async () => {
  const fanResults = [
    { ok: true, value: 'PostgreSQL' },
    { ok: true, value: 'Postgres' },
    { ok: true, value: 'PG' },
  ];
  const { deps } = stubDeps({
    fanResults,
    completeValue: { equivalent: true, answer: 'PostgreSQL', variants: [] },
  });
  const result = await runRouteMode('Which database?', [], { deps });
  assert.equal(result.requested, 3, 'omitting n must request the documented default of 3');
  assert.equal(result.used, 3);
});

// ---------------------------------------------------------------------------
// AC1 end-to-end — the CLI turns a refusal into exit 1, never `gate PASSES`
// ---------------------------------------------------------------------------

test('AC1: an off-schema divergence payload exits 1 from the CLI and never prints gate PASSES', () => {
  const r = runMocked(['--request', 'Add a login page', '--n', '2'], {
    fan: TWO_GOOD_READINGS,
    divergence: { error: 'I cannot comply' },
  });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(!r.stdout.includes('gate PASSES'), 'an unmeasured spec must never render as a passing gate');
  assert.match(r.stderr, /agreements/);
});

test('AC1: --questions-json on an off-schema payload exits 1 rather than emitting an empty frontier', () => {
  const r = runMocked(['--request', 'Add a login page', '--n', '2', '--questions-json'], {
    fan: TWO_GOOD_READINGS,
    divergence: {},
  });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}`);
  assert.ok(!r.stdout.includes('"questions"'), 'no question payload may be emitted for an unmeasured spec');
});

test('AC4: the CLI refuses a shrunken fan, and --allow-partial-fan accepts it', () => {
  const mock = {
    fan: [okResult(reading('A')), okResult(reading('B')), failResult('rate limit')],
    divergence: CONVERGED,
  };

  const refused = runMocked(['--request', 'Add a login page', '--n', '3'], mock);
  assert.equal(refused.status, 1, `expected exit 1, got ${refused.status}\nstderr: ${refused.stderr}`);
  assert.match(refused.stderr, /--allow-partial-fan/);

  const allowed = runMocked(['--request', 'Add a login page', '--n', '3', '--allow-partial-fan'], mock);
  assert.equal(allowed.status, 0, `expected exit 0, got ${allowed.status}\nstderr: ${allowed.stderr}`);
  assert.ok(allowed.stdout.includes('gate PASSES'));
});

// ---------------------------------------------------------------------------
// AC5 — requested/used reach both machine contracts in all three modes
// ---------------------------------------------------------------------------

test('AC5: spec mode --json and --questions-json carry requested and used', () => {
  const mock = { fan: TWO_GOOD_READINGS, divergence: CONVERGED };

  const asJson = runMocked(['--request', 'Add a login page', '--n', '2', '--json'], mock);
  assert.equal(asJson.status, 0, asJson.stderr);
  const payload = JSON.parse(asJson.stdout);
  assert.equal(payload.mode, 'spec');
  assert.equal(payload.requested, 2);
  assert.equal(payload.used, 2);

  const asQuestions = runMocked(['--request', 'Add a login page', '--n', '2', '--questions-json'], mock);
  assert.equal(asQuestions.status, 0, asQuestions.stderr);
  const questions = JSON.parse(asQuestions.stdout);
  assert.equal(questions.requested, 2);
  assert.equal(questions.used, 2);
});

test('AC5: edge mode --json and --questions-json carry requested and used', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-fan-'));
  try {
    const ticketsFile = join(dir, 'tickets.json');
    writeFileSync(ticketsFile, JSON.stringify({
      tickets: [
        { id: 'T1', title: 'Auth Service', body: 'Build auth', scope: [] },
        { id: 'T2', title: 'API Gateway', body: 'Route requests', scope: [] },
      ],
    }));
    const mock = { fan: TWO_GOOD_READINGS, divergence: CONVERGED };
    const base = ['--edge', 'T1', 'T2', '--tickets', ticketsFile, '--n', '2'];

    const asJson = runMocked([...base, '--json'], mock, { cwd: dir });
    assert.equal(asJson.status, 0, asJson.stderr);
    const payload = JSON.parse(asJson.stdout);
    assert.equal(payload.mode, 'edge');
    assert.deepEqual(payload.tickets, ['T1', 'T2'], 'both ticket ids identify the edge');
    assert.equal(payload.gate, true, 'a converged edge passes the gate');
    assert.equal(payload.requested, 2);
    assert.equal(payload.used, 2);

    const asQuestions = runMocked([...base, '--questions-json'], mock, { cwd: dir });
    assert.equal(asQuestions.status, 0, asQuestions.stderr);
    const questions = JSON.parse(asQuestions.stdout);
    assert.deepEqual(questions.tickets, ['T1', 'T2']);
    assert.equal(questions.requested, 2);
    assert.equal(questions.used, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC5: route mode --json and --questions-json carry requested and used', () => {
  const mock = {
    fan: [{ ok: true, value: 'PostgreSQL' }, { ok: true, value: 'Postgres' }],
    judge: { equivalent: false, answer: '', variants: ['PostgreSQL', 'MySQL'] },
  };

  const asJson = runMocked(['--route', 'Which database?', '--n', '2', '--json'], mock);
  const payload = JSON.parse(asJson.stdout);
  assert.equal(payload.mode, 'route');
  assert.equal(payload.requested, 2);
  assert.equal(payload.used, 2);

  const asQuestions = runMocked(['--route', 'Which database?', '--n', '2', '--questions-json'], mock);
  const questions = JSON.parse(asQuestions.stdout);
  assert.equal(questions.requested, 2);
  assert.equal(questions.used, 2);
});

test('AC5: route mode reports requested/used on the equivalent (passing) branch too', () => {
  const mock = {
    fan: [{ ok: true, value: 'PostgreSQL' }, { ok: true, value: 'Postgres' }],
    judge: { equivalent: true, answer: 'PostgreSQL', variants: [] },
  };
  const asJson = runMocked(['--route', 'Which database?', '--n', '2', '--json'], mock);
  assert.equal(asJson.status, 0, asJson.stderr);
  const payload = JSON.parse(asJson.stdout);
  assert.equal(payload.requested, 2);
  assert.equal(payload.used, 2);

  const asQuestions = runMocked(['--route', 'Which database?', '--n', '2', '--questions-json'], mock);
  assert.equal(asQuestions.status, 0, asQuestions.stderr);
  const questions = JSON.parse(asQuestions.stdout);
  assert.equal(questions.gate, true);
  assert.equal(questions.requested, 2);
  assert.equal(questions.used, 2);
});

// ---------------------------------------------------------------------------
// AC7 — --record-verdict is bound to a ticket
// ---------------------------------------------------------------------------

function readManifestEntries(dir) {
  const manifestPath = join(dir, '.adlc', 'manifest.jsonl');
  return readFileSync(manifestPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('AC7: --record-verdict without --ticket exits 1 and records nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-fan-'));
  try {
    const verdictPath = join(dir, 'verdict.txt');
    writeFileSync(verdictPath, 'no divergence found\n');
    const r = run(['--request', 'Add a login page', '--prompt-only', '--record-verdict', verdictPath], { cwd: dir });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}`);
    assert.match(r.stderr, /--ticket/);
    assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false, 'an unbound record must not be written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC7: --record-verdict with --ticket records an entry bound to that ticket', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-fan-'));
  try {
    const verdictPath = join(dir, 'verdict.txt');
    writeFileSync(verdictPath, 'no divergence found\n');
    const r = run(
      ['--request', 'Add a login page', '--prompt-only', '--ticket', 'T1', '--record-verdict', verdictPath],
      { cwd: dir }
    );
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    const [entry] = readManifestEntries(dir);
    assert.equal(entry.gate, 'parallax');
    assert.equal(entry.ticket, 'T1', 'the manifest entry must carry the ticket id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC7: edge and route modes bind their recorded verdicts too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-fan-'));
  try {
    const verdictPath = join(dir, 'verdict.txt');
    writeFileSync(verdictPath, 'answered\n');

    const route = run(
      ['--route', 'What is the retry policy?', '--prompt-only', '--record-verdict', verdictPath],
      { cwd: dir }
    );
    assert.equal(route.status, 1, 'route mode must require --ticket too');
    assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false);

    const bound = run(
      ['--route', 'What is the retry policy?', '--prompt-only', '--ticket', 'T9', '--record-verdict', verdictPath],
      { cwd: dir }
    );
    assert.equal(bound.status, 0, bound.stderr);
    const [entry] = readManifestEntries(dir);
    assert.equal(entry.ticket, 'T9');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC7: --ticket without --record-verdict is accepted and records nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-fan-'));
  try {
    const r = run(['--request', 'Add a login page', '--prompt-only', '--ticket', 'T1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The mock seam must never be reachable outside a test run
// ---------------------------------------------------------------------------

test('the ADLC_GATE_MOCK_RESPONSE seam is ignored unless NODE_ENV is test', () => {
  const r = run(['--request', 'Add a login page', '--n', '2'], {
    env: { ...process.env, NODE_ENV: 'production', ADLC_GATE_MOCK_RESPONSE: JSON.stringify({ fan: TWO_GOOD_READINGS, divergence: CONVERGED }) },
  });
  assert.notEqual(r.status, 0, 'a mocked verdict must never be produced outside a test run');
  assert.ok(!r.stdout.includes('gate PASSES'));
});

test('an unparseable mock fails closed rather than degrading to a passing gate', () => {
  const r = runMocked(['--request', 'Add a login page', '--n', '2'], 'not json');
  assert.notEqual(r.status, 0);
  assert.ok(!r.stdout.includes('gate PASSES'));
});
