// cache.test.mjs — issue #278: pure unit tests for findCachedVerdict/buildCacheData.
// No I/O — plain fixture arrays standing in for manifest entries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCachedVerdict, buildCacheData, buildRecordPlan, GATE_NAME } from '../lib/cache.mjs';

function entry({ gate = GATE_NAME, ts = '2026-01-01T00:00:00.000Z', cache } = {}) {
  return { gate, ts, data: { cache } };
}

test('buildCacheData shapes a cache record from ticketHash/model/gaps', () => {
  const data = buildCacheData({ ticketHash: 'H1', model: 'claude-haiku-4-5', gaps: [{ what: 'X', why_blocking: 'Y' }] });
  assert.deepEqual(data, { ticketHash: 'H1', model: 'claude-haiku-4-5', gaps: [{ what: 'X', why_blocking: 'Y' }] });
});

test('buildCacheData defaults gaps to [] when omitted', () => {
  const data = buildCacheData({ ticketHash: 'H1', model: 'm' });
  assert.deepEqual(data.gaps, []);
});

test('findCachedVerdict: no entries → null', () => {
  assert.equal(findCachedVerdict([], { ticketHash: 'H1', model: 'm' }), null);
});

test('findCachedVerdict: matching gate/hash/model → hit, returns cached gaps', () => {
  const entries = [entry({ cache: { ticketHash: 'H1', model: 'm', gaps: [{ what: 'X', why_blocking: 'Y' }] } })];
  const result = findCachedVerdict(entries, { ticketHash: 'H1', model: 'm' });
  assert.deepEqual(result, { gaps: [{ what: 'X', why_blocking: 'Y' }] });
});

test('findCachedVerdict: different ticketHash → miss', () => {
  const entries = [entry({ cache: { ticketHash: 'H1', model: 'm', gaps: [] } })];
  assert.equal(findCachedVerdict(entries, { ticketHash: 'H2', model: 'm' }), null);
});

test('findCachedVerdict: different model (e.g. ADLC_MODEL_CHEAP changed) → miss', () => {
  const entries = [entry({ cache: { ticketHash: 'H1', model: 'claude-haiku-4-5', gaps: [] } })];
  assert.equal(findCachedVerdict(entries, { ticketHash: 'H1', model: 'claude-3-5-haiku' }), null);
});

test('findCachedVerdict: entries from a different gate are ignored', () => {
  const entries = [entry({ gate: 'rails-guard', cache: { ticketHash: 'H1', model: 'm', gaps: [] } })];
  assert.equal(findCachedVerdict(entries, { ticketHash: 'H1', model: 'm' }), null);
});

test('findCachedVerdict: entries with no data.cache (e.g. a --record-verdict entry) are ignored, not thrown on', () => {
  const entries = [{ gate: GATE_NAME, ts: '2026-01-01T00:00:00.000Z', data: { promptOnly: true, verdict: 'PASS' } }];
  assert.equal(findCachedVerdict(entries, { ticketHash: 'H1', model: 'm' }), null);
});

test('findCachedVerdict: within maxAgeMs → hit', () => {
  const entries = [entry({ ts: '2026-01-01T00:00:00.000Z', cache: { ticketHash: 'H1', model: 'm', gaps: [] } })];
  const now = Date.parse('2026-01-01T00:00:00.000Z') + 1000; // 1s later
  const result = findCachedVerdict(entries, { ticketHash: 'H1', model: 'm', maxAgeMs: 5000, now });
  assert.notEqual(result, null);
});

test('findCachedVerdict: past maxAgeMs → treated as stale, miss', () => {
  const entries = [entry({ ts: '2026-01-01T00:00:00.000Z', cache: { ticketHash: 'H1', model: 'm', gaps: [] } })];
  const now = Date.parse('2026-01-01T00:00:00.000Z') + 10_000; // 10s later
  const result = findCachedVerdict(entries, { ticketHash: 'H1', model: 'm', maxAgeMs: 5000, now });
  assert.equal(result, null);
});

test('findCachedVerdict: maxAgeMs 0 → every entry is stale regardless of age', () => {
  const entries = [entry({ ts: '2026-01-01T00:00:00.000Z', cache: { ticketHash: 'H1', model: 'm', gaps: [] } })];
  const now = Date.parse('2026-01-01T00:00:00.000Z') + 1; // 1ms later, still > 0
  const result = findCachedVerdict(entries, { ticketHash: 'H1', model: 'm', maxAgeMs: 0, now });
  assert.equal(result, null);
});

test('findCachedVerdict: null maxAgeMs (default) never expires', () => {
  const entries = [entry({ ts: '2020-01-01T00:00:00.000Z', cache: { ticketHash: 'H1', model: 'm', gaps: [] } })];
  const now = Date.parse('2030-01-01T00:00:00.000Z'); // 10 years later
  const result = findCachedVerdict(entries, { ticketHash: 'H1', model: 'm', maxAgeMs: null, now });
  assert.notEqual(result, null);
});

test('findCachedVerdict: walks newest-first — a later re-audit shadows an older entry for the same hash+model', () => {
  const entries = [
    entry({ ts: '2026-01-01T00:00:00.000Z', cache: { ticketHash: 'H1', model: 'm', gaps: [{ what: 'old', why_blocking: 'stale gap' }] } }),
    entry({ ts: '2026-01-02T00:00:00.000Z', cache: { ticketHash: 'H1', model: 'm', gaps: [] } }), // re-audited clean later
  ];
  const result = findCachedVerdict(entries, { ticketHash: 'H1', model: 'm' });
  assert.deepEqual(result.gaps, []);
});

// ── buildRecordPlan (issue #278 / mutation-gate follow-up on PR #291) ─────

test('buildRecordPlan: no results → empty plan (nothing to record)', () => {
  assert.deepEqual(buildRecordPlan([], [], { model: 'm', tier: 'cheap' }), []);
});

test('buildRecordPlan: a cached result is excluded — reusing prior evidence is not new evidence', () => {
  const targets = [{ id: 'T1', title: 't' }];
  const results = [{ id: 'T1', gaps: [], usage: null, cached: true }];
  assert.deepEqual(buildRecordPlan(results, targets, { model: 'm', tier: 'cheap' }), []);
});

test('buildRecordPlan: a mocked result is excluded — no real call was made', () => {
  const targets = [{ id: 'T1', title: 't' }];
  const results = [{ id: 'T1', gaps: [], usage: null, mocked: true }];
  assert.deepEqual(buildRecordPlan(results, targets, { model: 'm', tier: 'cheap' }), []);
});

test('buildRecordPlan: exactly one freshly-audited result produces exactly one plan entry', () => {
  const targets = [{ id: 'T1', title: 't' }];
  const results = [{ id: 'T1', gaps: [], usage: null, cached: false }];
  const plan = buildRecordPlan(results, targets, { model: 'claude-haiku-4-5', tier: 'cheap' });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].gate, GATE_NAME);
  assert.equal(plan[0].ticket, 'T1');
  const data = JSON.parse(plan[0].rawData);
  assert.equal(data.tier, 'cheap');
  assert.equal(data.cache.model, 'claude-haiku-4-5');
  assert.deepEqual(data.cache.gaps, []);
});

test('buildRecordPlan: a mix of cached/mocked/fresh results only plans entries for the fresh ones', () => {
  const targets = [{ id: 'T1', title: 'a' }, { id: 'T2', title: 'b' }, { id: 'T3', title: 'c' }];
  const results = [
    { id: 'T1', gaps: [], usage: null, cached: true },
    { id: 'T2', gaps: [], usage: null, mocked: true },
    { id: 'T3', gaps: [{ what: 'X', why_blocking: 'Y' }], usage: null, cached: false },
  ];
  const plan = buildRecordPlan(results, targets, { model: 'm', tier: 'cheap' });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].ticket, 'T3');
});

test('buildRecordPlan: with no provider configured (model is null), the plan still records usage/tier but omits cache data', () => {
  const targets = [{ id: 'T1', title: 't' }];
  const results = [{ id: 'T1', gaps: [], usage: null, cached: false }];
  const plan = buildRecordPlan(results, targets, { model: null, tier: 'cheap' });
  assert.equal(plan.length, 1);
  const data = JSON.parse(plan[0].rawData);
  assert.equal('cache' in data, false);
});

test('buildRecordPlan: includes usage when the result reported it', () => {
  const targets = [{ id: 'T1', title: 't' }];
  const usage = { inputTokens: 100, outputTokens: 20, cachedTokens: 0, provider: 'anthropic', model: 'claude-haiku-4-5', tier: 'cheap' };
  const results = [{ id: 'T1', gaps: [], usage, cached: false }];
  const plan = buildRecordPlan(results, targets, { model: 'claude-haiku-4-5', tier: 'cheap' });
  const data = JSON.parse(plan[0].rawData);
  assert.deepEqual(data.usage, usage);
});
