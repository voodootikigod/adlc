import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSpend, computeBarbellMetrics } from '../lib/spend.mjs';

function usage({ inputTokens = 0, outputTokens = 0, cachedTokens = 0, provider = 'anthropic', model = 'claude-sonnet-4-6', tier = 'mid' } = {}) {
  return { inputTokens, outputTokens, cachedTokens, provider, model, tier };
}

describe('barbell metrics', () => {
  it('computes barbellRatio, p4Share, cacheHitRate, and measuredCallShare correctly', () => {
    const entries = [
      // P1: 100 in, 20 out, 10 cached -> tok = 130
      { gate: 'spec-lint', data: { usage: usage({ inputTokens: 100, outputTokens: 20, cachedTokens: 10 }) } },
      // P2: 200 in, 30 out, 20 cached -> tok = 250
      { gate: 'coldstart', data: { usage: usage({ inputTokens: 200, outputTokens: 30, cachedTokens: 20 }) } },
      // P4: 50 in, 10 out, 0 cached -> tok = 60
      { gate: 'p4', data: { usage: usage({ inputTokens: 50, outputTokens: 10, cachedTokens: 0 }) } },
      // P5: 300 in, 50 out, 30 cached -> tok = 380
      { gate: 'prosecute', data: { usage: usage({ inputTokens: 300, outputTokens: 50, cachedTokens: 30 }) } },
      // unmeasured call in P4
      { gate: 'p4', data: { usageStatus: 'reported' } },
    ];

    const agg = aggregateSpend(entries);
    assert.ok(agg.metrics);

    // p1p2p5 = 130 + 250 + 380 = 760
    // p4 = 60
    // barbellRatio = 760 / 60 = 12.66666...
    assert.equal(agg.metrics.barbellRatio, 760 / 60);

    // totalTok = 760 + 60 = 820
    // p4Share = 60 / 820
    assert.equal(agg.metrics.p4Share, 60 / 820);

    // total inputTokens = 100 + 200 + 50 + 300 = 650
    // total cachedTokens = 10 + 20 + 0 + 30 = 60
    // cacheHitRate = 60 / (650 + 60) = 60 / 710
    assert.equal(agg.metrics.cacheHitRate, 60 / 710);

    // total calls = 4 measured, 1 unmeasured -> measuredCallShare = 4 / 5 = 0.8
    assert.equal(agg.metrics.measuredCallShare, 4 / 5);
  });

  it('handles empty or zero spend gracefully with null metrics', () => {
    const agg = aggregateSpend([]);
    assert.deepEqual(agg.metrics, {
      barbellRatio: null,
      p4Share: null,
      cacheHitRate: null,
      measuredCallShare: null,
    });
  });

  it('computeBarbellMetrics can be called standalone', () => {
    const emptyAgg = {
      byPhase: {},
      byGate: {},
      total: { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, unmeasuredCalls: 0 },
      unmeasuredCalls: 0,
    };
    const m = computeBarbellMetrics(emptyAgg);
    assert.equal(m.barbellRatio, null);
    assert.equal(m.p4Share, null);
    assert.equal(m.cacheHitRate, null);
    assert.equal(m.measuredCallShare, null);
  });
});
