// review-calibration/test/scorer.test.mjs
// Dedicated coverage for lib/scorer.mjs: locating findings, identifying
// matches (judge or behavioral verifyRepro), recall/precision aggregation,
// and false-positive counting.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scorePlants, locatingFindings, countFalsePositives, findIdentifying } from '../lib/scorer.mjs';
import { referenceJudge } from '../lib/judge.mjs';
import { echoReviewer, oracleReviewer } from '../lib/controls.mjs';

// ── scorePlants — verifier-based scoring ──────────────────────────────────────

describe('scorePlants', () => {
  const plants = [
    { file: 'src/math.mjs', line: 5, operator: 'off-by-one', category: 'off-by-one',
      defect: 'Off-by-one error: boundary shifted by one.', original: 'n + 1', mutated: 'n + 2' },
    { file: 'src/math.mjs', line: 10, operator: 'bool-flip', category: 'logic-inversion',
      defect: 'Inverted boolean flips the branch taken.', original: 'return true', mutated: 'return false' },
    { file: 'src/auth.mjs', line: 20, operator: 'invert-comparison', category: 'logic-inversion',
      defect: 'Inverted comparison matches the opposite case.', original: 'x > 0', mutated: 'x <= 0' },
  ];

  it('throws without a judge — refuses to string-match', async () => {
    await assert.rejects(() => scorePlants(plants, [], {}), /requires a judge/);
  });

  it('oracle reviewer (perfect findings) → recall 1.0', async () => {
    const findings = oracleReviewer(plants);
    const score = await scorePlants(plants, findings, { judge: referenceJudge });
    assert.equal(score.recall, 1);
    assert.equal(score.caught, 3);
  });

  it('echo reviewer (content-free) → recall ~0  [INVERTED: this used to score 1.0]', async () => {
    const findings = echoReviewer(plants);
    const score = await scorePlants(plants, findings, { judge: referenceJudge });
    assert.equal(score.caught, 0);
    assert.equal(score.recall, 0);
  });

  it('a finding must LOCATE and IDENTIFY — locating without identifying misses', async () => {
    // located at the right line, but the description identifies nothing
    const findings = [{ file: 'math.mjs', line: 5, description: 'line 5 was modified', evidence: 'n + 2' }];
    const score = await scorePlants(plants, findings, { judge: referenceJudge });
    assert.equal(score.caught, 0);
  });

  it('identifying at the wrong location does not count', async () => {
    const findings = [{ file: 'math.mjs', line: 99, description: 'off-by-one boundary error' }];
    const score = await scorePlants(plants, findings, { judge: referenceJudge });
    assert.equal(score.caught, 0);
  });

  it('partial catch → fractional recall, keyed per category', async () => {
    const findings = [
      { file: 'math.mjs', line: 5, description: 'off-by-one: boundary shifted' },
      { file: 'auth.mjs', line: 20, description: 'comparison inverted, opposite case' },
    ];
    const score = await scorePlants(plants, findings, { judge: referenceJudge });
    assert.equal(score.caught, 2);
    assert.ok(Math.abs(score.recall - 2 / 3) < 1e-6);
    assert.equal(score.perCategory['off-by-one'].caught, 1);
    assert.equal(score.perCategory['logic-inversion'].total, 2);
    assert.equal(score.perCategory['logic-inversion'].caught, 1);
  });

  it('precision falls when findings flag unplanted locations', async () => {
    const findings = [
      { file: 'math.mjs', line: 5, description: 'off-by-one boundary shifted' }, // TP
      { file: 'other.mjs', line: 99, description: 'spurious' },                   // FP (no plant)
    ];
    const score = await scorePlants(plants, findings, { judge: referenceJudge });
    assert.equal(score.truePositives, 1);
    assert.equal(score.falsePositives, 1);
    assert.equal(score.precision, 0.5);
  });

  it('uses a reviewer-supplied repro behaviorally when present (verifyRepro)', async () => {
    const findings = [{ file: 'math.mjs', line: 5, description: 'anything', repro: { cmd: 'x' } }];
    // verifyRepro discriminates → caught even though the judge would say no
    const judge = () => false;
    const verifyRepro = () => true;
    const score = await scorePlants(plants, findings, { judge, verifyRepro });
    assert.equal(score.results.find((r) => r.line === 5).caught, true);
  });

  it('a repro that does NOT discriminate is not a catch', async () => {
    const findings = [{ file: 'math.mjs', line: 5, description: 'x', repro: { cmd: 'x' } }];
    const score = await scorePlants(plants, findings, { judge: () => true, verifyRepro: () => false });
    assert.equal(score.results.find((r) => r.line === 5).caught, false);
  });
});

// ── findIdentifying ────────────────────────────────────────────────────────────

describe('findIdentifying', () => {
  it('returns the first locating finding the judge accepts', async () => {
    const plant = { defect: 'x' };
    const located = [{ id: 1 }, { id: 2 }];
    const judge = async (_p, f) => f.id === 2;
    const hit = await findIdentifying(plant, located, { judge });
    assert.equal(hit.id, 2);
  });

  it('returns null when no located finding identifies the defect', async () => {
    const plant = { defect: 'x' };
    const located = [{ id: 1 }];
    const hit = await findIdentifying(plant, located, { judge: async () => false });
    assert.equal(hit, null);
  });

  it('a repro that fails to discriminate is skipped, not treated as a miss for the whole search', async () => {
    const plant = { defect: 'x' };
    const located = [{ id: 1, repro: { cmd: 'x' } }, { id: 2 }];
    const verifyRepro = async () => false; // first finding's repro doesn't discriminate
    const judge = async (_p, f) => f.id === 2; // second finding is judged and accepted
    const hit = await findIdentifying(plant, located, { judge, verifyRepro });
    assert.equal(hit.id, 2);
  });
});

// ── locatingFindings ───────────────────────────────────────────────────────────

describe('locatingFindings', () => {
  const plant = { file: 'src/a.mjs', line: 10 };

  it('matches by basename, ignoring directory differences', () => {
    const findings = [{ file: 'a.mjs', line: 10 }, { file: 'other/a.mjs', line: 10 }];
    assert.equal(locatingFindings(plant, findings).length, 2);
  });

  it('respects the default tolerance of ±3 lines', () => {
    assert.equal(locatingFindings(plant, [{ file: 'a.mjs', line: 13 }]).length, 1);
    assert.equal(locatingFindings(plant, [{ file: 'a.mjs', line: 14 }]).length, 0);
  });

  it('honors a custom tolerance', () => {
    assert.equal(locatingFindings(plant, [{ file: 'a.mjs', line: 20 }], 10).length, 1);
  });
});

// ── countFalsePositives ────────────────────────────────────────────────────────

describe('countFalsePositives', () => {
  it('counts findings located at no plant', () => {
    const plants = [{ file: 'math.mjs', line: 10 }];
    const findings = [{ file: 'math.mjs', line: 10 }, { file: 'other.mjs', line: 5 }];
    assert.equal(countFalsePositives(findings, plants), 1);
  });

  it('±3 proximity counts as matching a plant', () => {
    assert.equal(countFalsePositives([{ file: 'a.mjs', line: 12 }], [{ file: 'a.mjs', line: 10 }]), 0);
  });

  it('zero findings → zero false positives', () => {
    assert.equal(countFalsePositives([], [{ file: 'x.mjs', line: 1 }]), 0);
  });
});
