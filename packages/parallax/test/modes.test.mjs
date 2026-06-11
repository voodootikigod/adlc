// Tests for lib/modes.mjs — offline, no network.
// Tests cover: parseFanResults (>=2 readings guard, error-tolerant parsing,
// extractJson recovery), parseFanAnswers, prompt construction used by modes,
// and divergence scoring from fixture readings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFanResults, parseFanAnswers } from '../lib/modes.mjs';
import { buildSpecReaderPrompt, buildEdgePrompt, buildDivergencePrompt } from '../lib/prompts.mjs';
import { computeScore, renderReport } from '../lib/scoring.mjs';

// ---------------------------------------------------------------------------
// parseFanResults — tolerant parsing of fan output
// ---------------------------------------------------------------------------

test('parseFanResults: all ok results → all parsed as readings', () => {
  const reading = { spec: 'Login page with username/password', assumptions: ['email-based'], decisions: [] };
  const fanResults = [
    { ok: true, value: JSON.stringify(reading) },
    { ok: true, value: JSON.stringify({ ...reading, spec: 'Login form with OAuth' }) },
  ];
  const { readings, errors } = parseFanResults(fanResults);
  assert.equal(readings.length, 2);
  assert.equal(errors.length, 0);
  assert.equal(readings[0].spec, 'Login page with username/password');
  assert.equal(readings[1].spec, 'Login form with OAuth');
});

test('parseFanResults: failed fan call → error collected, reading skipped', () => {
  const reading = { spec: 'Spec A', assumptions: [], decisions: [] };
  const fanResults = [
    { ok: false, error: 'API timeout' },
    { ok: true, value: JSON.stringify(reading) },
    { ok: true, value: JSON.stringify({ ...reading, spec: 'Spec B' }) },
  ];
  const { readings, errors } = parseFanResults(fanResults);
  assert.equal(readings.length, 2);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('API timeout'));
});

test('parseFanResults: parse error on malformed JSON → error collected, reading skipped', () => {
  const goodReading = { spec: 'Valid spec', assumptions: [], decisions: [] };
  const fanResults = [
    { ok: true, value: 'not json at all' },
    { ok: true, value: JSON.stringify(goodReading) },
    { ok: true, value: JSON.stringify({ ...goodReading, spec: 'Another valid spec' }) },
  ];
  const { readings, errors } = parseFanResults(fanResults);
  assert.equal(readings.length, 2);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('parse error'));
});

test('parseFanResults: JSON embedded in prose → extractJson recovers it', () => {
  const reading = { spec: 'Recovered spec', assumptions: ['a1'], decisions: [] };
  const fanResults = [
    { ok: true, value: `Here is my analysis:\n${JSON.stringify(reading)}\nThat's my output.` },
    { ok: true, value: JSON.stringify({ ...reading, spec: 'Direct spec' }) },
  ];
  const { readings, errors } = parseFanResults(fanResults);
  assert.equal(readings.length, 2);
  assert.equal(errors.length, 0);
  assert.equal(readings[0].spec, 'Recovered spec');
});

test('parseFanResults: code-fenced JSON → extractJson strips fences', () => {
  const reading = { spec: 'Fenced spec', assumptions: [], decisions: [] };
  const fanResults = [
    { ok: true, value: '```json\n' + JSON.stringify(reading) + '\n```' },
    { ok: true, value: JSON.stringify({ ...reading, spec: 'Plain spec' }) },
  ];
  const { readings, errors } = parseFanResults(fanResults);
  assert.equal(readings.length, 2);
  assert.equal(errors.length, 0);
  assert.equal(readings[0].spec, 'Fenced spec');
});

test('parseFanResults: all fail → zero readings, all errors collected', () => {
  const fanResults = [
    { ok: false, error: 'network error 1' },
    { ok: false, error: 'network error 2' },
    { ok: false, error: 'network error 3' },
  ];
  const { readings, errors } = parseFanResults(fanResults);
  assert.equal(readings.length, 0);
  assert.equal(errors.length, 3);
});

test('parseFanResults: only one ok result → one reading, others in errors', () => {
  const reading = { spec: 'Only one', assumptions: [], decisions: [] };
  const fanResults = [
    { ok: true, value: JSON.stringify(reading) },
    { ok: false, error: 'call failed' },
    { ok: true, value: 'no json here at all' },
  ];
  const { readings, errors } = parseFanResults(fanResults);
  assert.equal(readings.length, 1);
  assert.equal(errors.length, 2);
});

test('parseFanResults: empty fanResults → zero readings, zero errors', () => {
  const { readings, errors } = parseFanResults([]);
  assert.equal(readings.length, 0);
  assert.equal(errors.length, 0);
});

// ---------------------------------------------------------------------------
// parseFanAnswers — route mode answer parsing
// ---------------------------------------------------------------------------

test('parseFanAnswers: all ok → all answers collected', () => {
  const fanResults = [
    { ok: true, value: 'Use PostgreSQL' },
    { ok: true, value: 'PostgreSQL is the right choice' },
    { ok: true, value: 'Prefer PostgreSQL for ACID compliance' },
  ];
  const { rawAnswers, errors } = parseFanAnswers(fanResults);
  assert.equal(rawAnswers.length, 3);
  assert.equal(errors.length, 0);
  assert.ok(rawAnswers[0].includes('PostgreSQL'));
});

test('parseFanAnswers: failed call → error collected, answer skipped', () => {
  const fanResults = [
    { ok: false, error: 'timeout' },
    { ok: true, value: 'Use Redis' },
    { ok: true, value: 'Redis for caching' },
  ];
  const { rawAnswers, errors } = parseFanAnswers(fanResults);
  assert.equal(rawAnswers.length, 2);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('timeout'));
});

test('parseFanAnswers: all fail → zero answers', () => {
  const fanResults = [
    { ok: false, error: 'err1' },
    { ok: false, error: 'err2' },
  ];
  const { rawAnswers, errors } = parseFanAnswers(fanResults);
  assert.equal(rawAnswers.length, 0);
  assert.equal(errors.length, 2);
});

test('parseFanAnswers: empty → zero answers, zero errors', () => {
  const { rawAnswers, errors } = parseFanAnswers([]);
  assert.equal(rawAnswers.length, 0);
  assert.equal(errors.length, 0);
});

// ---------------------------------------------------------------------------
// >=2 readings guard — the guard lives in runDivergenceAnalysis (network),
// but the logic is exercised via parseFanResults + a manual check matching
// the guard condition
// ---------------------------------------------------------------------------

test('>=2 readings guard: parseFanResults with 2 ok → does not trigger guard', () => {
  const r = { spec: 'S', assumptions: [], decisions: [] };
  const { readings } = parseFanResults([
    { ok: true, value: JSON.stringify(r) },
    { ok: true, value: JSON.stringify({ ...r, spec: 'T' }) },
  ]);
  // Guard condition from runDivergenceAnalysis: readings.length < 2
  assert.ok(readings.length >= 2, 'should have at least 2 readings');
});

test('>=2 readings guard: parseFanResults with 1 ok → triggers guard', () => {
  const r = { spec: 'S', assumptions: [], decisions: [] };
  const { readings } = parseFanResults([
    { ok: true, value: JSON.stringify(r) },
    { ok: false, error: 'failed' },
  ]);
  assert.ok(readings.length < 2, 'should have fewer than 2 readings — guard would fire');
});

test('>=2 answers guard: parseFanAnswers with 1 ok → triggers guard', () => {
  const { rawAnswers } = parseFanAnswers([
    { ok: true, value: 'answer' },
    { ok: false, error: 'failed' },
  ]);
  assert.ok(rawAnswers.length < 2, 'should have fewer than 2 answers — guard would fire');
});

// ---------------------------------------------------------------------------
// Prompt construction used by modes (spec + edge divergence path)
// ---------------------------------------------------------------------------

test('spec mode: fan prompt includes request and JSON keys', () => {
  const prompt = buildSpecReaderPrompt('Build a payment gateway');
  assert.ok(prompt.includes('Build a payment gateway'));
  assert.ok(prompt.includes('"spec"'));
  assert.ok(prompt.includes('"assumptions"'));
  assert.ok(prompt.includes('"decisions"'));
  assert.ok(prompt.includes('do NOT ask questions'));
  assert.ok(prompt.includes('ONE reading'));
});

test('edge mode: fan prompt includes both ticket titles and bodies', () => {
  const tA = { id: 'T-10', title: 'Auth module', body: 'Implement JWT auth' };
  const tB = { id: 'T-11', title: 'Profile service', body: 'Expose /profile endpoint' };
  const prompt = buildEdgePrompt(tA, tB);
  assert.ok(prompt.includes('T-10'));
  assert.ok(prompt.includes('Auth module'));
  assert.ok(prompt.includes('Implement JWT auth'));
  assert.ok(prompt.includes('T-11'));
  assert.ok(prompt.includes('Profile service'));
  assert.ok(prompt.includes('Expose /profile endpoint'));
  assert.ok(prompt.includes('interface/contract'));
  assert.ok(prompt.includes('function signatures'));
});

test('divergence prompt: built from fixture readings includes reading count', () => {
  const readings = [
    { spec: 'Spec A', assumptions: ['a1'], decisions: [{ point: 'p1', choice: 'c1' }] },
    { spec: 'Spec B', assumptions: ['b1'], decisions: [{ point: 'p2', choice: 'c2' }] },
    { spec: 'Spec C', assumptions: ['c1'], decisions: [] },
  ];
  const prompt = buildDivergencePrompt(readings);
  assert.ok(prompt.includes('3 independent readings'));
  assert.ok(prompt.includes('Reading 1'));
  assert.ok(prompt.includes('Reading 2'));
  assert.ok(prompt.includes('Reading 3'));
  assert.ok(prompt.includes('Spec A'));
  assert.ok(prompt.includes('Spec B'));
  assert.ok(prompt.includes('Spec C'));
  assert.ok(prompt.includes('"agreements"'));
  assert.ok(prompt.includes('"divergences"'));
});

// ---------------------------------------------------------------------------
// Divergence scoring math from fixture readings JSON
// ---------------------------------------------------------------------------

test('divergence scoring: 0 divergences / 3 agreements → score 0', () => {
  assert.equal(computeScore(0, 3), 0);
});

test('divergence scoring: 3 divergences / 0 agreements → score 1', () => {
  assert.equal(computeScore(3, 0), 1);
});

test('divergence scoring: 2 divergences / 3 agreements → score 0.4', () => {
  assert.equal(computeScore(2, 3), 0.4);
});

test('divergence scoring: 1 divergence / 3 agreements → score 0.25', () => {
  assert.equal(computeScore(1, 3), 0.25);
});

test('report rendering from fixture readings: agreements and divergences appear correctly', () => {
  const agreements = ['Must use HTTPS', 'Response format is JSON', 'Rate limiting required'];
  const divergences = [
    {
      point: 'Authentication mechanism',
      options: [
        { label: 'A', reading: 'JWT tokens' },
        { label: 'B', reading: 'Session cookies' },
      ],
    },
    {
      point: 'Token expiry',
      options: [
        { label: 'A', reading: '1 hour' },
        { label: 'B', reading: '24 hours' },
        { label: 'C', reading: '7 days' },
      ],
    },
  ];
  const score = computeScore(divergences.length, agreements.length);
  assert.equal(score, 0.4); // 2/(2+3)

  const report = renderReport({ agreements, divergences, score, threshold: 0.25 });

  // Agreement set section
  assert.ok(report.includes('## Agreement set (draft spec)'));
  assert.ok(report.includes('- Must use HTTPS'));
  assert.ok(report.includes('- Response format is JSON'));
  assert.ok(report.includes('- Rate limiting required'));

  // Divergences section
  assert.ok(report.includes('## Divergences — answer these'));
  assert.ok(report.includes('Q1: Authentication mechanism'));
  assert.ok(report.includes('A) JWT tokens'));
  assert.ok(report.includes('B) Session cookies'));
  assert.ok(report.includes('Q2: Token expiry'));
  assert.ok(report.includes('A) 1 hour'));
  assert.ok(report.includes('B) 24 hours'));
  assert.ok(report.includes('C) 7 days'));

  // Score and gate
  assert.ok(report.includes('0.40'));
  assert.ok(report.includes('FAILS'));
});

test('report rendering: score below threshold → PASSES gate', () => {
  const agreements = ['Use REST', 'JSON payloads', 'Standard HTTP verbs', 'Versioned via URL'];
  const divergences = [{ point: 'auth', options: [{ label: 'A', reading: 'JWT' }, { label: 'B', reading: 'OAuth' }] }];
  const score = computeScore(1, 4); // 0.2
  assert.ok(score <= 0.25);
  const report = renderReport({ agreements, divergences, score, threshold: 0.25 });
  assert.ok(report.includes('PASSES'));
  assert.ok(!report.includes('FAILS'));
});

test('full pipeline from fixture: parseFanResults → computeScore → renderReport', () => {
  // Simulate what runDivergenceAnalysis does after getting fan results
  const fixtureResults = [
    {
      ok: true,
      value: JSON.stringify({
        spec: 'REST API with JWT auth, returns user profile',
        assumptions: ['user is authenticated'],
        decisions: [{ point: 'token storage', choice: 'localStorage' }],
      }),
    },
    {
      ok: true,
      value: JSON.stringify({
        spec: 'GraphQL API with session auth, returns user object',
        assumptions: ['user is logged in'],
        decisions: [{ point: 'token storage', choice: 'httpOnly cookie' }],
      }),
    },
    {
      ok: false,
      error: 'rate limited',
    },
  ];

  const { readings, errors } = parseFanResults(fixtureResults);
  assert.equal(readings.length, 2);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('rate limited'));

  // Simulate what the divergence call would return (fixture)
  const fixtureAgreements = ['returns user data', 'requires authentication'];
  const fixtureDivergences = [
    { point: 'API style', options: [{ label: 'A', reading: 'REST' }, { label: 'B', reading: 'GraphQL' }] },
    { point: 'token storage', options: [{ label: 'A', reading: 'localStorage' }, { label: 'B', reading: 'httpOnly cookie' }] },
  ];

  const score = computeScore(fixtureDivergences.length, fixtureAgreements.length);
  assert.equal(score, 0.5); // 2/(2+2)

  const report = renderReport({ agreements: fixtureAgreements, divergences: fixtureDivergences, score, threshold: 0.25 });
  assert.ok(report.includes('## Agreement set (draft spec)'));
  assert.ok(report.includes('returns user data'));
  assert.ok(report.includes('## Divergences — answer these'));
  assert.ok(report.includes('Q1: API style'));
  assert.ok(report.includes('Q2: token storage'));
  assert.ok(report.includes('FAILS'));
});
