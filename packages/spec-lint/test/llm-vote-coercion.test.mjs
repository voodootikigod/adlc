// llm-vote-coercion.test.mjs — #774: --llm vote payloads must be validated and
// coerced (numeric-string indices accepted, anything unusable fails closed),
// never silently coerced to "nothing vacuous".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { validateVacuousPayload, detectVacuous, shouldUseMockResponse } from '../lib/llm.mjs';
import { applyLlmDemotion } from '../lib/classify.mjs';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;
const BIN = new URL('../bin/spec-lint.mjs', import.meta.url).pathname;

function runCliLlm(mockResponse) {
  const specPath = join(FIXTURES, 'all-verified.md');
  try {
    const out = execFileSync(process.execPath, [BIN, specPath, '--llm', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', ADLC_GATE_MOCK_RESPONSE: mockResponse },
    });
    return { stdout: out, stderr: '', code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.status ?? 1 };
  }
}

// ---------------------------------------------------------------------------
// validateVacuousPayload — the pure validator/coercer (no LLM call)
// ---------------------------------------------------------------------------

describe('validateVacuousPayload', () => {
  it('accepts numeric indices unchanged', () => {
    const result = validateVacuousPayload({ vacuous: [0, 1], reason: {} }, 3);
    assert.deepEqual(result.vacuous, [0, 1]);
  });

  it('coerces numeric-STRING indices to numbers', () => {
    const result = validateVacuousPayload({ vacuous: ['0', '1'], reason: { '0': 'x' } }, 3);
    assert.deepEqual(result.vacuous, [0, 1]);
    // reason keys stay string-keyed (applyLlmDemotion looks up String(subIdx))
    assert.equal(result.reason['0'], 'x');
  });

  it('accepts an empty vacuous array (nothing vacuous)', () => {
    const result = validateVacuousPayload({ vacuous: [], reason: {} }, 3);
    assert.deepEqual(result.vacuous, []);
  });

  it('accepts a mix of numbers and numeric strings', () => {
    const result = validateVacuousPayload({ vacuous: [0, '2'], reason: {} }, 3);
    assert.deepEqual(result.vacuous, [0, 2]);
  });

  it('throws when vacuous field is missing', () => {
    assert.throws(
      () => validateVacuousPayload({ result: 'ok' }, 3),
      /missing/i,
    );
  });

  it('throws "missing" (not "must be an array") when vacuous is explicitly null', () => {
    // Distinguishes the missing-field guard from the array-type guard: a
    // mutated `||` -> `&&` on the missing-field check would let this fall
    // through to the array-type check instead, which ALSO throws but with a
    // different message — this assertion pins which guard actually fired.
    assert.throws(() => validateVacuousPayload({ vacuous: null }, 3), /missing/i);
  });

  it('throws "must be an array" (not "missing") when vacuous is a non-array value', () => {
    assert.throws(() => validateVacuousPayload({ vacuous: 'none' }, 3), /must be an array/i);
  });

  it('throws when the whole payload is not an object (a bare string)', () => {
    // Distinguishes the top-level shape guard from every guard that assumes
    // `parsed` is already an object — a mutated `||` -> `&&` here would let
    // a bare-string response (typeof !== 'object', not null, not an array)
    // pass through this guard unnoticed.
    assert.throws(() => validateVacuousPayload('just a string', 3), /missing/i);
  });

  it('throws when the whole payload is a bare number', () => {
    assert.throws(() => validateVacuousPayload(42, 3), /missing/i);
  });

  it('throws when an entry is non-numeric', () => {
    assert.throws(
      () => validateVacuousPayload({ vacuous: [0, 'abc'] }, 3),
      /integer|numeric|non-numeric/i,
    );
  });

  it('throws when an entry is out of range (>= verifiedCount)', () => {
    assert.throws(
      () => validateVacuousPayload({ vacuous: [0, 99] }, 3),
      /range|99/,
    );
  });

  it('throws when an entry is negative', () => {
    assert.throws(() => validateVacuousPayload({ vacuous: [-1] }, 3), /range|negative/i);
  });

  it('throws when an entry is a non-integer number', () => {
    assert.throws(() => validateVacuousPayload({ vacuous: [1.5] }, 3), /integer/i);
  });

  it('throws (does not silently coerce to index 0) when an entry is null', () => {
    // Number(null) === 0 — without an explicit type check this would be
    // silently accepted as "demote index 0" instead of rejected.
    assert.throws(() => validateVacuousPayload({ vacuous: [null] }, 3), /non-numeric index of type object/i);
  });

  it('throws (does not silently coerce to index 0/1) when an entry is a boolean', () => {
    // Number(false) === 0, Number(true) === 1 — same silent-coercion trap.
    assert.throws(() => validateVacuousPayload({ vacuous: [false] }, 3), /non-numeric index of type boolean/i);
    assert.throws(() => validateVacuousPayload({ vacuous: [true] }, 3), /non-numeric index of type boolean/i);
  });

  it('throws (does not silently coerce to index 0) when an entry is an empty or blank string', () => {
    // Number('') === 0, Number('   ') === 0 — same silent-coercion trap.
    assert.throws(() => validateVacuousPayload({ vacuous: [''] }, 3), /blank string index/i);
    assert.throws(() => validateVacuousPayload({ vacuous: ['   '] }, 3), /blank string index/i);
  });

  it('rejects a bare top-level array (no vacuous wrapper) — deliberate, not a recovered deviation', () => {
    // Unlike coldstart's #594 fix (which recovers a bare array because its
    // prompt is ambiguous about shape), this package's prompt explicitly asks
    // for {"vacuous": [...], "reason": {...}} — a bare array is a genuine
    // shape violation, not a plausible deviation to special-case.
    assert.throws(() => validateVacuousPayload([0, 1], 3), /vacuous/i);
  });

  it('error messages distinguish the failure kind', () => {
    let missingMsg, typeMsg, rangeMsg, numericMsg;
    try { validateVacuousPayload({}, 3); } catch (e) { missingMsg = e.message; }
    try { validateVacuousPayload({ vacuous: 5 }, 3); } catch (e) { typeMsg = e.message; }
    try { validateVacuousPayload({ vacuous: [10] }, 3); } catch (e) { rangeMsg = e.message; }
    try { validateVacuousPayload({ vacuous: ['x'] }, 3); } catch (e) { numericMsg = e.message; }
    // Every message is distinct (not a single generic "invalid payload" string).
    const msgs = new Set([missingMsg, typeMsg, rangeMsg, numericMsg]);
    assert.equal(msgs.size, 4);
  });
});

// ---------------------------------------------------------------------------
// detectVacuous — injectable complete/extractJson (no network), mirrors the
// coldstart buildCheckTicket(completeFn, extractJsonFn) testability pattern.
// ---------------------------------------------------------------------------

describe('detectVacuous with injected complete/extractJson', () => {
  const criteria = [
    { line: 1, text: 'a' },
    { line: 2, text: 'b' },
    { line: 3, text: 'c' },
  ];

  it('returns numeric-coerced vacuous indices for a string-index response', async () => {
    const stubComplete = async () => '{"vacuous":["0","1"],"reason":{"0":"vague"}}';
    const stubExtractJson = (text) => JSON.parse(text);
    const result = await detectVacuous(criteria, 'cheap', {
      completeFn: stubComplete,
      extractJsonFn: stubExtractJson,
    });
    assert.deepEqual(result.vacuous, [0, 1]);
    assert.equal(result.reason['0'], 'vague');
  });

  it('propagates a validation error for a malformed response (never silently empty)', async () => {
    const stubComplete = async () => '{"result":"ok"}';
    const stubExtractJson = (text) => JSON.parse(text);
    await assert.rejects(
      () => detectVacuous(criteria, 'cheap', { completeFn: stubComplete, extractJsonFn: stubExtractJson }),
      /vacuous/i,
    );
  });

  it('propagates a validation error for an out-of-range index', async () => {
    const stubComplete = async () => '{"vacuous":[0,99]}';
    const stubExtractJson = (text) => JSON.parse(text);
    await assert.rejects(
      () => detectVacuous(criteria, 'cheap', { completeFn: stubComplete, extractJsonFn: stubExtractJson }),
      /range|99/,
    );
  });

  it('empty verifiedCriteria still short-circuits to {vacuous:[],reason:{}} with no call', async () => {
    let called = false;
    const stubComplete = async () => { called = true; return '{"vacuous":[]}'; };
    const result = await detectVacuous([], 'cheap', { completeFn: stubComplete, extractJsonFn: JSON.parse });
    assert.deepEqual(result, { vacuous: [], reason: {} });
    assert.equal(called, false);
  });
});

// ---------------------------------------------------------------------------
// shouldUseMockResponse — the three-way mock-gating decision, unit-tested
// directly for every combination so no real network call is ever at risk.
// ---------------------------------------------------------------------------

describe('shouldUseMockResponse', () => {
  it('true only when completeFn is undefined AND mockEnv is set AND nodeEnv is test', () => {
    assert.equal(shouldUseMockResponse({ completeFn: undefined, mockEnv: '{}', nodeEnv: 'test' }), true);
  });

  it('false when completeFn was explicitly injected, even if mock env + test are set', () => {
    assert.equal(shouldUseMockResponse({ completeFn: async () => '{}', mockEnv: '{}', nodeEnv: 'test' }), false);
  });

  it('false when mockEnv is unset, even with no completeFn and nodeEnv=test', () => {
    // The dangerous case: without this guard a production call (no injected
    // completeFn, mockEnv unset) under a mutated `||` would wrongly "mock" a
    // real request with an undefined response.
    assert.equal(shouldUseMockResponse({ completeFn: undefined, mockEnv: undefined, nodeEnv: 'test' }), false);
  });

  it('false when nodeEnv is not "test", even with no completeFn and mockEnv set', () => {
    assert.equal(shouldUseMockResponse({ completeFn: undefined, mockEnv: '{}', nodeEnv: 'production' }), false);
    assert.equal(shouldUseMockResponse({ completeFn: undefined, mockEnv: '{}', nodeEnv: undefined }), false);
  });

  it('false when both completeFn is injected AND the env conditions are absent', () => {
    assert.equal(shouldUseMockResponse({ completeFn: async () => '{}', mockEnv: undefined, nodeEnv: undefined }), false);
  });
});

// ---------------------------------------------------------------------------
// CLI integration — the real bin/spec-lint.mjs process, driven end to end via
// the ADLC_GATE_MOCK_RESPONSE test seam (NODE_ENV=test), exercising the full
// wiring: flag parsing -> detectVacuous -> validateVacuousPayload -> opError's
// exit code. all-verified.md has 6 verified criteria (indices 0-5).
// ---------------------------------------------------------------------------

describe('CLI: --llm end to end via the mock seam', () => {
  it('string-index response demotes and exits with gate-fail (real vacuous criteria)', () => {
    const { code, stdout } = runCliLlm('{"vacuous":["0","2"],"reason":{"0":"vague","2":"vague"}}');
    assert.equal(code, 2);
    const result = JSON.parse(stdout);
    const wishes = result.criteria.filter((c) => c.status === 'WISH');
    assert.ok(wishes.length >= 2, 'expected at least the 2 demoted criteria to be WISH');
  });

  it('a malformed payload (missing vacuous field) exits 1, never "all criteria verified"', () => {
    const { code, stdout, stderr } = runCliLlm('{"result":"ok"}');
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /missing/i);
  });

  it('a payload with a null entry exits 1, not a silent index-0 demotion', () => {
    const { code, stderr } = runCliLlm('{"vacuous":[null]}');
    assert.equal(code, 1);
    assert.match(stderr, /non-numeric index/i);
  });

  it('an empty vacuous array is a genuine clean pass, exit 0, no demotions', () => {
    const { code, stdout } = runCliLlm('{"vacuous":[],"reason":{}}');
    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.ok(result.criteria.every((c) => c.status === 'VERIFIED'), 'all-verified.md has no non-verified criteria to begin with');
  });
});

// ---------------------------------------------------------------------------
// applyLlmDemotion — defensive Array.isArray guard for a wrong-shaped payload
// reaching classify.mjs from any caller (belt-and-suspenders; llm.mjs's
// contract should already prevent this).
// ---------------------------------------------------------------------------

describe('applyLlmDemotion defensive guard', () => {
  it('throws rather than iterating undefined when vacuous is not an array', () => {
    const classified = [{ line: 1, text: 'x', status: 'VERIFIED', reason: 'r' }];
    assert.throws(
      () => applyLlmDemotion(classified, { vacuous: 'not-an-array' }, [0]),
      /array/i,
    );
  });
});
