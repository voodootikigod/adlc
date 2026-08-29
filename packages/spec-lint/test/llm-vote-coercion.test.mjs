// llm-vote-coercion.test.mjs — #774: --llm vote payloads must be validated and
// coerced (numeric-string indices accepted, anything unusable fails closed),
// never silently coerced to "nothing vacuous".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateVacuousPayload, detectVacuous } from '../lib/llm.mjs';
import { applyLlmDemotion } from '../lib/classify.mjs';

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
      /vacuous.*missing|missing.*vacuous/i,
    );
  });

  it('throws when vacuous is null', () => {
    assert.throws(() => validateVacuousPayload({ vacuous: null }, 3), /vacuous/i);
  });

  it('throws when vacuous is a string, not an array', () => {
    assert.throws(() => validateVacuousPayload({ vacuous: 'none' }, 3), /array/i);
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
