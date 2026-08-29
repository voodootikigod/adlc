// verdict-shape.test.mjs — issue #594: a shape-deviant LLM verdict must be an
// OPERATIONAL error (exit 1, "could not read the verdict"), never coerced to
// zero gaps (a false PASS). A bare top-level array — the most common model
// deviation from {"gaps":[...]} — is recovered as the gaps list.
//
// Ticket T-01M173B7HYWF9ME9NXJ1PEPME8. Every case here is one the pre-fix code
// collapsed to `gaps: []` and reported "[PASS] ticket is fully executable".

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractJson } from '@adlc/core';
import { normalizeGaps, describeShape, UNREADABLE_VERDICT_PREFIX } from '../lib/normalize-gaps.mjs';
import { buildCheckTicket, checkTicket } from '../lib/gate.mjs';
import { findCachedVerdict } from '../lib/cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'bin', 'coldstart.mjs');
const UNREADABLE = /unreadable executability verdict/;

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — normalizeGaps is the single shape authority
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeGaps — accepted shapes', () => {
  test('{gaps: []} → []', () => {
    assert.deepEqual(normalizeGaps({ gaps: [] }), []);
  });

  test('{gaps: [{what}]} → the same entries', () => {
    const gaps = [{ what: 'a', why_blocking: 'b' }];
    assert.deepEqual(normalizeGaps({ gaps }), gaps);
  });

  test('a bare top-level array is recovered as the gaps list (the dangerous #594 case)', () => {
    const gaps = [{ what: 'UserSchema', why_blocking: 'missing' }];
    assert.deepEqual(normalizeGaps(gaps), gaps);
  });

  test('a bare EMPTY array is a clean verdict', () => {
    assert.deepEqual(normalizeGaps([]), []);
  });

  test('string entries are wrapped as {what, why_blocking: "unspecified"}', () => {
    assert.deepEqual(normalizeGaps({ gaps: ['x'] }), [{ what: 'x', why_blocking: 'unspecified' }]);
    assert.deepEqual(normalizeGaps(['x', { what: 'y', why_blocking: 'z' }]), [
      { what: 'x', why_blocking: 'unspecified' },
      { what: 'y', why_blocking: 'z' },
    ]);
  });

  test('extra top-level keys next to a well-formed gaps array are tolerated', () => {
    assert.deepEqual(normalizeGaps({ gaps: [], note: 'looks fine' }), []);
  });

  test('returns a new array, never the caller\'s (no aliasing of model output)', () => {
    const gaps = [{ what: 'a', why_blocking: 'b' }];
    const out = normalizeGaps({ gaps });
    assert.notEqual(out, gaps);
  });
});

describe('normalizeGaps — every other shape throws "unreadable executability verdict"', () => {
  const THROWING = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'two gaps found'],
    ['{} (no gaps key)', {}],
    ['{result: "ok"}', { result: 'ok' }],
    ['{blockers: [...]} (wrong key)', { blockers: [{ what: 'a', why_blocking: 'b' }] }],
    ['{gaps: null}', { gaps: null }],
    ['{gaps: "text"}', { gaps: 'two gaps found' }],
    ['{gaps: {}}', { gaps: {} }],
    ['{gaps: [42]}', { gaps: [42] }],
    ['{gaps: [null]}', { gaps: [null] }],
    ['{gaps: [[]]}', { gaps: [[]] }],
    ['{gaps: [{}]} (entry without a string `what`)', { gaps: [{}] }],
    ['{gaps: [{what: 42}]}', { gaps: [{ what: 42 }] }],
    ['a bare array of numbers', [1, 2]],
    ['a boolean', true],
  ];

  for (const [label, input] of THROWING) {
    test(`${label} throws`, () => {
      assert.throws(() => normalizeGaps(input), (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, UNREADABLE);
        assert.ok(err.message.startsWith(UNREADABLE_VERDICT_PREFIX), `message must start with the prefix, got: ${err.message}`);
        return true;
      });
    });
  }

  test('the error describes the received shape (type / keys), never dumps it: bounded length', () => {
    const huge = { blockers: 'x'.repeat(10_000), other: 'y'.repeat(10_000) };
    let message;
    try { normalizeGaps(huge); } catch (err) { message = err.message; }
    assert.ok(message, 'must throw');
    assert.ok(message.length < 400, `message must stay short, got ${message.length} chars`);
    assert.ok(message.includes('blockers'), 'message should name the top-level keys it saw');
    assert.ok(!message.includes('x'.repeat(300)), 'message must not embed the raw payload');
  });

  test('a huge string input is described, not echoed', () => {
    let message;
    try { normalizeGaps('z'.repeat(5_000)); } catch (err) { message = err.message; }
    assert.ok(message.length < 400, `got ${message.length} chars`);
    assert.match(message, /string/);
  });
});

describe('describeShape — the bounded shape description', () => {
  const keysObject = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`key${i}`, i]));

  test('lists at most 8 top-level keys: exactly 8 keys are all named, with no ellipsis', () => {
    const text = describeShape(keysObject(8));
    for (let i = 0; i < 8; i++) assert.ok(text.includes(`key${i}`), `key${i} must be named in: ${text}`);
    assert.ok(!text.includes('…'), `no ellipsis for exactly 8 keys: ${text}`);
  });

  test('a 9th key is elided behind an ellipsis, never named', () => {
    const text = describeShape(keysObject(9));
    assert.ok(text.includes('key7'), text);
    assert.ok(!text.includes('key8'), `the 9th key must not be named: ${text}`);
    assert.ok(text.includes('…'), `ellipsis expected: ${text}`);
  });

  test('an object description is cut at exactly 160 characters (a single huge key cannot flood the message)', () => {
    const text = describeShape({ ['k'.repeat(1_000)]: 1 });
    assert.equal(text.length, 160);
    // …and one that fits is not cut.
    assert.equal(describeShape({ a: 1 }), 'object with keys [a]');
  });

  test('primitive shapes: type only, never the value', () => {
    assert.equal(describeShape(42), 'number');
    assert.equal(describeShape(true), 'boolean');
    assert.equal(describeShape(undefined), 'undefined');
    assert.equal(describeShape(null), 'null');
    assert.equal(describeShape([1, 2, 3]), 'array(3)');
    assert.equal(describeShape('secret-value'), 'string(12 chars)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — buildCheckTicket with the REAL extractJson
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCheckTicket (real extractJson)', () => {
  const ticket = { id: 'T1', title: 'Add endpoint', body: 'POST /users' };

  test('a bare top-level array from the model surfaces as gaps (was: gaps=[] → PASS)', async () => {
    const stub = async () => '[{"what":"UserSchema","why_blocking":"missing"}]';
    const result = await buildCheckTicket(stub, extractJson)(ticket);
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].what, 'UserSchema');
  });

  test('a bare array wrapped in prose/fences is still recovered', async () => {
    const stub = async () => 'Here you go:\n```json\n[{"what":"a","why_blocking":"b"}]\n```';
    const result = await buildCheckTicket(stub, extractJson)(ticket);
    assert.equal(result.gaps.length, 1);
  });

  test('{"result":"ok"} rejects with the unreadable-verdict error (was: gaps=[] → PASS)', async () => {
    const stub = async () => '{"result":"ok"}';
    await assert.rejects(() => buildCheckTicket(stub, extractJson)(ticket), UNREADABLE);
  });

  test('{"gaps":null}, {"gaps":"text"} and {"blockers":[...]} all reject', async () => {
    for (const raw of ['{"gaps":null}', '{"gaps":"two gaps found"}', '{"blockers":[{"what":"a"}]}']) {
      await assert.rejects(() => buildCheckTicket(async () => raw, extractJson)(ticket), UNREADABLE, raw);
    }
  });

  test('{"gaps":[]} still resolves clean (regression)', async () => {
    const result = await buildCheckTicket(async () => '{"gaps":[]}', extractJson)(ticket);
    assert.deepEqual(result.gaps, []);
  });

  test('unparseable text still rejects via extractJson (unchanged)', async () => {
    await assert.rejects(() => buildCheckTicket(async () => 'no json here', extractJson)(ticket), /extractJson/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — the ADLC_GATE_MOCK_RESPONSE seam fails closed too (lib + CLI)
// ─────────────────────────────────────────────────────────────────────────────

function withMockEnv(raw, fn) {
  const origMock = process.env.ADLC_GATE_MOCK_RESPONSE;
  const origNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  process.env.ADLC_GATE_MOCK_RESPONSE = raw;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (origMock === undefined) delete process.env.ADLC_GATE_MOCK_RESPONSE;
      else process.env.ADLC_GATE_MOCK_RESPONSE = origMock;
      if (origNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = origNodeEnv;
    });
}

describe('checkTicket mock seam (NODE_ENV=test + ADLC_GATE_MOCK_RESPONSE)', () => {
  const ticket = { id: 'T_MOCK', title: 't' };

  test('invalid JSON in the mock rejects (was: silently {} → gaps=[])', async () => {
    await withMockEnv('invalid json', () => assert.rejects(() => checkTicket(ticket), UNREADABLE));
  });

  test('a shape-deviant mock rejects', async () => {
    await withMockEnv('{"result":"ok"}', () => assert.rejects(() => checkTicket(ticket), UNREADABLE));
  });

  test('a bare-array mock is recovered as gaps, still flagged mocked with null usage', async () => {
    await withMockEnv('[{"what":"x","why_blocking":"y"}]', async () => {
      const result = await checkTicket(ticket);
      assert.equal(result.gaps.length, 1);
      assert.equal(result.mocked, true);
      assert.equal(result.usage, null);
    });
  });

  test('{"gaps":[]} mock still resolves clean (regression)', async () => {
    await withMockEnv('{"gaps":[]}', async () => {
      const result = await checkTicket(ticket);
      assert.deepEqual(result.gaps, []);
    });
  });
});

describe('CLI via the mock seam', () => {
  let tmpDir;
  let ticketsPath;

  test.before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'coldstart-verdict-shape-'));
    ticketsPath = join(tmpDir, 'tickets.json');
    writeFileSync(ticketsPath, JSON.stringify({ tickets: [{ id: 'T1', title: 'Vague ticket' }] }, null, 2));
  });

  test.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(rawMock, extraArgs = []) {
    return spawnSync(process.execPath, [CLI, 'T1', '--tickets', ticketsPath, ...extraArgs], {
      cwd: tmpDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        ANTHROPIC_API_KEY: 'mock-key-for-testing',
        OPENAI_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        ADLC_GATE_MOCK_RESPONSE: rawMock,
      },
    });
  }

  test('{"result":"ok"} → exit 1, stderr names the unreadable verdict, stdout has no [PASS]', () => {
    const res = run('{"result":"ok"}');
    assert.equal(res.status, 1, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, UNREADABLE);
    assert.ok(!res.stdout.includes('[PASS]'), `stdout must not report a pass: ${res.stdout}`);
  });

  test('{"result":"ok"} --json → exit 1 and no ok:true document on stdout', () => {
    const res = run('{"result":"ok"}', ['--json']);
    assert.equal(res.status, 1, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.ok(!res.stdout.includes('"ok": true'), `stdout: ${res.stdout}`);
  });

  test('"not json" → exit 1 with the unreadable-verdict cause', () => {
    const res = run('not json');
    assert.equal(res.status, 1, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, UNREADABLE);
  });

  test('a bare array with one gap → exit 2 listing the gap', () => {
    const res = run('[{"what":"UserSchema","why_blocking":"shape not defined"}]');
    assert.equal(res.status, 2, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stdout, /UserSchema: shape not defined/);
  });

  test('{"gaps":[]} → exit 0 [PASS] (regression)', () => {
    const res = run('{"gaps":[]}');
    assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stdout, /\[PASS\] T1/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — a cached verdict with an unreadable gaps shape is not a cache hit
// ─────────────────────────────────────────────────────────────────────────────

describe('findCachedVerdict shape validation', () => {
  const ticketHash = 'h1';
  const model = 'claude-haiku-4-5';
  const entry = (gaps, ts = '2026-08-01T00:00:00.000Z') => ({
    gate: 'coldstart',
    ts,
    data: { cache: { ticketHash, model, gaps } },
  });

  test('gaps: "clean" (a string) is NOT a hit', () => {
    assert.equal(findCachedVerdict([entry('clean')], { ticketHash, model }), null);
  });

  test('gaps: null / missing / {} are NOT hits (was: coerced to [] → cached PASS)', () => {
    assert.equal(findCachedVerdict([entry(null)], { ticketHash, model }), null);
    assert.equal(findCachedVerdict([entry(undefined)], { ticketHash, model }), null);
    assert.equal(findCachedVerdict([entry({})], { ticketHash, model }), null);
    assert.equal(findCachedVerdict([entry([42])], { ticketHash, model }), null);
  });

  test('gaps: [] is still a hit; gaps: [{what}] is returned as-is', () => {
    assert.deepEqual(findCachedVerdict([entry([])], { ticketHash, model }), { gaps: [] });
    const gaps = [{ what: 'a', why_blocking: 'b' }];
    assert.deepEqual(findCachedVerdict([entry(gaps)], { ticketHash, model }), { gaps });
  });

  test('an unreadable newest entry is skipped and an older readable one is still found', () => {
    const entries = [entry([{ what: 'a', why_blocking: 'b' }], '2026-08-01T00:00:00.000Z'), entry('clean', '2026-08-02T00:00:00.000Z')];
    assert.deepEqual(findCachedVerdict(entries, { ticketHash, model }), { gaps: [{ what: 'a', why_blocking: 'b' }] });
  });
});
