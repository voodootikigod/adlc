// review-calibration/test/judge.test.mjs
// Dedicated coverage for lib/judge.mjs: the LLM judge, its deterministic
// reference double, calibration against labeled fixtures, and the
// provider-independence guard (issue #64 — "who reviews the reviewer" must
// not be satisfiable by the judge and the reviewer-under-test sharing a
// model family).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  referenceJudge, defectTokens, calibrateJudge, makeLlmJudge,
  checkProviderIndependence,
} from '../lib/judge.mjs';

// ── referenceJudge / defectTokens ─────────────────────────────────────────────

describe('referenceJudge / defectTokens', () => {
  const plant = {
    file: 'src/auth.mjs', line: 5, category: 'logic-inversion',
    defect: 'Inverted comparison: the conditional now matches the opposite case.',
    original: 'if (x > 0)', mutated: 'if (x <= 0)',
  };

  it('extracts content tokens from the defect text', () => {
    const t = defectTokens(plant);
    assert.ok(t.includes('inverted'));
    assert.ok(t.includes('comparison'));
    assert.ok(!t.includes('the')); // stopword / too short
  });

  it('accepts a finding that describes the defect', () => {
    assert.equal(referenceJudge(plant, { description: 'The comparison is inverted, matching the opposite case' }), true);
  });

  it('REJECTS a content-free echo finding (this is the whole fix)', () => {
    assert.equal(referenceJudge(plant, { description: 'auth.mjs:5 changed' }), false);
  });

  it('rejects a finding quoting only the raw mutated line with no defect claim', () => {
    assert.equal(referenceJudge(plant, { description: 'if (x <= 0)' }), false);
  });
});

// ── calibrateJudge ────────────────────────────────────────────────────────────

describe('calibrateJudge', () => {
  it('measures agreement of a judge against labeled pairs', async () => {
    const p = { defect: 'Inverted comparison opposite case.', category: 'logic-inversion' };
    const fixture = [
      { plant: p, finding: { description: 'comparison inverted, opposite case' }, expected: true },
      { plant: p, finding: { description: 'a.mjs:1 changed' }, expected: false },
      { plant: p, finding: { description: 'the comparison is now inverted' }, expected: true },
    ];
    const { agreement, n } = await calibrateJudge(fixture, referenceJudge);
    assert.equal(n, 3);
    assert.equal(agreement, 1); // reference judge agrees with all three labels
  });

  it('reports disagreements when the judge is wrong', async () => {
    const p = { defect: 'Off-by-one boundary error.', category: 'off-by-one' };
    const alwaysTrue = () => true;
    const fixture = [{ plant: p, finding: { description: 'noise' }, expected: false }];
    const { agreement, disagreements } = await calibrateJudge(fixture, alwaysTrue);
    assert.equal(agreement, 0);
    assert.equal(disagreements.length, 1);
  });
});

// ── makeLlmJudge (injected completion, no network) ────────────────────────────

describe('makeLlmJudge', () => {
  it('builds the judge prompt from plant + finding and parses {match}', async () => {
    let seen;
    const completeFn = async (opts) => { seen = opts; return '{"match": true}'; };
    const extractJsonFn = (t) => JSON.parse(t);
    const judge = makeLlmJudge(completeFn, extractJsonFn);
    const plant = { file: 'a.mjs', line: 5, category: 'off-by-one', defect: 'boundary shifted', original: 'i<=n', mutated: 'i<n' };
    const finding = { file: 'a.mjs', line: 5, description: 'loop misses last element' };
    const out = await judge(plant, finding);
    assert.equal(out, true);
    assert.equal(seen.tier, 'cheap');
    assert.ok(seen.prompt.includes('boundary shifted'));
    assert.ok(seen.prompt.includes('loop misses last element'));
  });

  it('returns false when the model does not answer match:true', async () => {
    const judge = makeLlmJudge(async () => '{"match": false}', (t) => JSON.parse(t));
    assert.equal(await judge({ defect: 'x' }, { description: 'y' }), false);
  });
});

// ── checkProviderIndependence (issue #64) ─────────────────────────────────────
// The judge is resolved via the same auto-detect path as everything else, while
// the reviewer-under-test runs as an opaque subprocess via --review-cmd. Nothing
// compared the two, so "who reviews the reviewer" could silently be satisfied by
// the same model family reviewing itself. --review-provider lets the caller
// state the reviewer's provider explicitly (the subprocess can't be introspected
// generically); this guard compares it against the judge's resolved provider.

describe('checkProviderIndependence', () => {
  it('flags same-family judge and reviewer as NOT independent', () => {
    const result = checkProviderIndependence('anthropic', 'anthropic');
    assert.equal(result.same, true);
    assert.equal(result.reviewProvider, 'anthropic');
    assert.equal(result.judgeProvider, 'anthropic');
  });

  it('is case-insensitive and trims whitespace', () => {
    assert.equal(checkProviderIndependence(' Anthropic ', 'anthropic').same, true);
    assert.equal(checkProviderIndependence('OPENAI', 'openai').same, true);
  });

  it('treats known aliases as the same family (claude -> anthropic, gpt -> openai)', () => {
    assert.equal(checkProviderIndependence('claude', 'anthropic').same, true);
    assert.equal(checkProviderIndependence('gpt', 'openai').same, true);
  });

  it('does not flag genuinely different providers', () => {
    const result = checkProviderIndependence('openai', 'anthropic');
    assert.equal(result.same, false);
  });

  it('cannot flag anything when either side is undeclared (no comparison possible)', () => {
    assert.equal(checkProviderIndependence(undefined, 'anthropic').same, false);
    assert.equal(checkProviderIndependence('anthropic', undefined).same, false);
    assert.equal(checkProviderIndependence(undefined, undefined).same, false);
  });
});
