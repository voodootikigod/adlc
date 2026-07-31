// spend.test.mjs — aggregation of recorded token usage (issue #272).
// Offline, no API keys, temp dirs cleaned up per test (mirrors
// gate-manifest.test.mjs conventions).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { record } from '../lib/record.mjs';
import { aggregateSpend, diagnostics, renderSpendReport, loadSpend, PHASE_BY_GATE } from '../lib/spend.mjs';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'gate-manifest-spend-test-'));
}

function cleanTmp(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function usage({ inputTokens = 0, outputTokens = 0, cachedTokens = 0, provider = 'anthropic', model = 'claude-sonnet-4-6', tier = 'mid' } = {}) {
  return { inputTokens, outputTokens, cachedTokens, provider, model, tier };
}

describe('aggregateSpend', () => {
  it('entries with no data.usage are not counted', () => {
    const agg = aggregateSpend([{ gate: 'build', ts: '2026-01-01T00:00:00Z' }]);
    assert.equal(agg.entriesWithUsage, 0);
    assert.equal(agg.entriesTotal, 1);
    assert.deepEqual(agg.total, { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
  });

  it('attributes a known gate to its ADLC.md phase', () => {
    const entries = [{ gate: 'coldstart', data: { usage: usage({ inputTokens: 100, outputTokens: 20 }) } }];
    const agg = aggregateSpend(entries);
    assert.equal(agg.entriesWithUsage, 1);
    assert.ok(agg.byPhase.P2, 'coldstart is a P2 gate');
    assert.equal(agg.byPhase.P2.inputTokens, 100);
    assert.equal(agg.byPhase.P2.outputTokens, 20);
    assert.equal(agg.byGate.coldstart.phase, 'P2');
  });

  it('an unrecognized gate name falls under "unphased" rather than being silently dropped', () => {
    const entries = [{ gate: 'some-future-gate', data: { usage: usage({ inputTokens: 5, outputTokens: 1 }) } }];
    const agg = aggregateSpend(entries);
    assert.equal(agg.entriesWithUsage, 1);
    assert.ok(agg.byPhase.unphased);
    assert.equal(agg.byPhase.unphased.inputTokens, 5);
  });

  it('sums usage across multiple entries in the same phase (different gates)', () => {
    const entries = [
      { gate: 'spec-lint', data: { usage: usage({ inputTokens: 50, outputTokens: 10 }) } },
      { gate: 'premortem', data: { usage: usage({ inputTokens: 200, outputTokens: 40 }) } },
      { gate: 'parallax', data: { usage: usage({ inputTokens: 30, outputTokens: 5 }) } },
    ];
    const agg = aggregateSpend(entries);
    assert.equal(agg.byPhase.P1.calls, 3);
    assert.equal(agg.byPhase.P1.inputTokens, 280);
    assert.equal(agg.byPhase.P1.outputTokens, 55);
    assert.equal(agg.total.inputTokens, 280);
  });

  it('cachedTokens are tracked separately and summed', () => {
    const entries = [
      { gate: 'coldstart', data: { usage: usage({ inputTokens: 100, cachedTokens: 60 }) } },
      { gate: 'coldstart', data: { usage: usage({ inputTokens: 100, cachedTokens: 90 }) } },
    ];
    const agg = aggregateSpend(entries);
    assert.equal(agg.byGate.coldstart.cachedTokens, 150);
  });

  it('an entry with a malformed (non-object) data.usage is skipped, not thrown', () => {
    const entries = [
      { gate: 'coldstart', data: { usage: 'not-an-object' } },
      { gate: 'coldstart', data: { usage: usage({ inputTokens: 10 }) } },
    ];
    const agg = aggregateSpend(entries);
    assert.equal(agg.entriesWithUsage, 1);
    assert.equal(agg.byGate.coldstart.inputTokens, 10);
  });

  it('every gate in the phase map resolves to one of the ADLC.md phases (P0-P7 or maintenance)', () => {
    const validPhases = new Set(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'maintenance']);
    for (const [gate, phase] of Object.entries(PHASE_BY_GATE)) {
      assert.ok(validPhases.has(phase), `${gate} → ${phase} is not a recognized phase`);
    }
  });

  // ---- #418: the fleet's PHASE-named gates ----

  it("the fleet's own gate names attribute to their phase, not to 'unphased'", () => {
    // The fleet records evidence under the phase it just ran (`gate: 'p4'`),
    // not under a tool name. Before this mapping existed every dispatch's spend
    // fell to 'unphased', so P4 was the one phase whose spend could not be
    // attributed at all. Exact numbers, not merely nonzero.
    const p4 = aggregateSpend([{ gate: 'p4', data: { usage: usage({ inputTokens: 100, outputTokens: 20 }) } }]);
    assert.deepEqual(p4.byPhase.P4, { calls: 1, inputTokens: 100, outputTokens: 20, cachedTokens: 0 });
    assert.equal(p4.byPhase.unphased, undefined, 'nothing may be left in unphased');

    const p5 = aggregateSpend([{ gate: 'p5', data: { usage: usage({ inputTokens: 7, outputTokens: 3, cachedTokens: 1 }) } }]);
    assert.deepEqual(p5.byPhase.P5, { calls: 1, inputTokens: 7, outputTokens: 3, cachedTokens: 1 });
    assert.equal(p5.byPhase.unphased, undefined);
  });

  it('an UNRECOGNIZED gate still falls through to unphased (staleness stays visible)', () => {
    // The table's doc comment promises this: a gate it does not know is
    // surfaced rather than silently mis-attributed. Adding p4/p5 must not turn
    // that fallback off.
    const agg = aggregateSpend([{ gate: 'some-future-gate', data: { usage: usage({ inputTokens: 5 }) } }]);
    assert.equal(agg.byPhase.unphased.calls, 1);
    assert.equal(Object.keys(agg.byPhase).length, 1);
  });

  it('the WHOLE table is pinned, so no future edit can silently move a gate between phases', () => {
    // Deliberately a literal map compared with deepEqual rather than a spot
    // check: a spot check cannot notice a gate quietly changing phase, which is
    // the failure that would silently re-attribute an entire phase's spend.
    assert.deepEqual(PHASE_BY_GATE, {
      'spec-lint': 'P1',
      premortem: 'P1',
      parallax: 'P1',
      coldstart: 'P2',
      'model-router': 'P2',
      'merge-forecast': 'P2',
      'rails-guard': 'P3',
      'flail-detector': 'P4',
      'consensus-fix': 'P4',
      p4: 'P4',
      'hollow-test': 'P5',
      'behavior-diff': 'P5',
      'review-calibration': 'P5',
      prosecute: 'P5',
      p5: 'P5',
      'lesson-foundry': 'P7',
      'rejection-mining': 'P7',
      'skill-rot': 'maintenance',
      'model-ratchet': 'maintenance',
      'gate-fuzzing': 'maintenance',
    });
  });
});

describe('diagnostics (ADLC.md §6)', () => {
  it('returns [] with fewer than 2 phases of recorded spend (not enough data to say anything)', () => {
    const agg = aggregateSpend([{ gate: 'coldstart', data: { usage: usage({ inputTokens: 100 }) } }]);
    assert.deepEqual(diagnostics(agg), []);
  });

  it('flags P4 concentration above 40% of total spend', () => {
    const entries = [
      { gate: 'flail-detector', data: { usage: usage({ inputTokens: 10_000, outputTokens: 1000 }) } }, // P4
      { gate: 'spec-lint', data: { usage: usage({ inputTokens: 1000, outputTokens: 100 }) } }, // P1
    ];
    const agg = aggregateSpend(entries);
    const diags = diagnostics(agg);
    assert.ok(diags.some((d) => d.includes('P4')), 'expected a P4-concentration diagnostic');
  });

  it('does not flag P4 when spend is genuinely barbell-shaped (P4 well under 40%)', () => {
    const entries = [
      { gate: 'flail-detector', data: { usage: usage({ inputTokens: 100, outputTokens: 10 }) } }, // P4, small
      { gate: 'spec-lint', data: { usage: usage({ inputTokens: 5000, outputTokens: 500 }) } }, // P1, heavy
      { gate: 'prosecute', data: { usage: usage({ inputTokens: 5000, outputTokens: 500 }) } }, // P5, heavy
    ];
    const agg = aggregateSpend(entries);
    const diags = diagnostics(agg);
    assert.ok(!diags.some((d) => d.includes('P4 (Build) is')), 'must not flag a healthy barbell shape');
  });

  it('flags missing P7 spend when P5 is heavy', () => {
    const entries = [
      { gate: 'prosecute', data: { usage: usage({ inputTokens: 10_000, outputTokens: 1000 }) } }, // P5
      { gate: 'spec-lint', data: { usage: usage({ inputTokens: 1000, outputTokens: 100 }) } }, // P1
    ];
    const agg = aggregateSpend(entries);
    const diags = diagnostics(agg);
    assert.ok(diags.some((d) => d.includes('P7')), 'expected a missing-P7 diagnostic');
  });
});

describe('renderSpendReport', () => {
  it('reports zero usage clearly when no entries carry data.usage', () => {
    const agg = aggregateSpend([{ gate: 'build' }, { gate: 'test' }]);
    const lines = renderSpendReport(agg).join('\n');
    assert.match(lines, /no recorded usage/);
    assert.match(lines, /0 of 2/);
  });

  it('renders a per-phase histogram line and a total line', () => {
    const entries = [
      { gate: 'coldstart', data: { usage: usage({ inputTokens: 100, outputTokens: 20 }) } },
      { gate: 'prosecute', data: { usage: usage({ inputTokens: 300, outputTokens: 60 }) } },
    ];
    const agg = aggregateSpend(entries);
    const lines = renderSpendReport(agg).join('\n');
    assert.match(lines, /P2/);
    assert.match(lines, /P5/);
    assert.match(lines, /total: 2 call\(s\), 480 tokens/);
  });
});

describe('loadSpend (integration with the real manifest ledger)', () => {
  it('aggregates usage recorded via record() into the same dir', () => {
    const dir = makeTmp();
    try {
      record({ key: null, gate: 'coldstart', dir, rawData: JSON.stringify({ usage: usage({ inputTokens: 400, outputTokens: 80 }) }) });
      record({ key: null, gate: 'prosecute', dir, rawData: JSON.stringify({ usage: usage({ inputTokens: 900, outputTokens: 150 }) }) });
      record({ key: null, gate: 'rails-guard', dir }); // no usage — deterministic gate, must not be counted

      const { aggregate } = loadSpend({ dir });
      assert.equal(aggregate.entriesTotal, 3);
      assert.equal(aggregate.entriesWithUsage, 2);
      assert.equal(aggregate.byPhase.P2.inputTokens, 400);
      assert.equal(aggregate.byPhase.P5.inputTokens, 900);
      assert.equal(aggregate.total.calls, 2);
    } finally {
      cleanTmp(dir);
    }
  });

  it('filters by ticket when given', () => {
    const dir = makeTmp();
    try {
      record({ key: null, gate: 'coldstart', ticket: 'T-1', dir, rawData: JSON.stringify({ usage: usage({ inputTokens: 100 }) }) });
      record({ key: null, gate: 'coldstart', ticket: 'T-2', dir, rawData: JSON.stringify({ usage: usage({ inputTokens: 500 }) }) });

      const { aggregate } = loadSpend({ dir, ticket: 'T-1' });
      assert.equal(aggregate.entriesTotal, 1);
      assert.equal(aggregate.total.inputTokens, 100);
    } finally {
      cleanTmp(dir);
    }
  });
});
