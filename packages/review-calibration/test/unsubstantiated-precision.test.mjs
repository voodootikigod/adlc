// review-calibration/test/unsubstantiated-precision.test.mjs
// A finding that locates a plant but does not identify its defect is an
// unsubstantiated claim, and precision counts it as a false positive. Without
// that, a reviewer that identifies one plant and pads every other plant with
// content-free echoes reports precision 1.0.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scorePlants } from '../lib/scorer.mjs';
import { buildJsonReport } from '../lib/report.mjs';

const PLANTS = [10, 50, 90, 130].map((line) => ({
  file: 'src/a.mjs', line, category: 'boundary', defect: 'bound shifted',
  original: 'x', mutated: 'y',
}));

const judgeRealOnly = (_plant, finding) => finding.description === 'real defect';

describe('precision counts located-but-unidentified findings as false positives', () => {
  it('one identifying finding plus three rejected echoes → precision 0.25', async () => {
    const findings = PLANTS.map((p, i) => ({
      file: 'a.mjs', line: p.line, description: i === 0 ? 'real defect' : 'a.mjs changed',
    }));
    const score = await scorePlants(PLANTS, findings, { judge: judgeRealOnly });
    assert.equal(score.caught, 1);
    assert.equal(score.truePositives, 1);
    assert.equal(score.unsubstantiated, 3);
    assert.equal(score.falsePositives, 3);
    assert.equal(score.precision, 0.25);
  });

  it('an echo placed AFTER the identifying finding at the same plant is still judged', async () => {
    const findings = [
      { file: 'a.mjs', line: 10, description: 'real defect' },
      { file: 'a.mjs', line: 11, description: 'a.mjs changed' },
    ];
    const score = await scorePlants([PLANTS[0]], findings, { judge: judgeRealOnly });
    assert.equal(score.caught, 1);
    assert.equal(score.unsubstantiated, 1);
    assert.equal(score.precision, 0.5);
  });

  it('a finding that identifies ONE of two plants it locates is not a false positive', async () => {
    const near = [
      { ...PLANTS[0], line: 10, defect: 'first' },
      { ...PLANTS[0], line: 12, defect: 'second' },
    ];
    const judge = (plant) => plant.defect === 'first';
    const score = await scorePlants(near, [{ file: 'a.mjs', line: 11, description: 'd' }], { judge });
    assert.equal(score.caught, 1);
    assert.equal(score.unsubstantiated, 0);
    assert.equal(score.falsePositives, 0);
    assert.equal(score.precision, 1);
  });

  it('an echo-only reviewer measures precision 0, not "unmeasurable"', async () => {
    const findings = PLANTS.map((p) => ({ file: 'a.mjs', line: p.line, description: 'changed' }));
    const score = await scorePlants(PLANTS, findings, { judge: judgeRealOnly });
    assert.equal(score.caught, 0);
    assert.equal(score.falsePositives, 4);
    assert.equal(score.precision, 0);
  });

  it('unlocated and unsubstantiated findings both count', async () => {
    const findings = [
      { file: 'a.mjs', line: 10, description: 'real defect' },
      { file: 'a.mjs', line: 50, description: 'changed' },
      { file: 'elsewhere.mjs', line: 1, description: 'spurious' },
    ];
    const score = await scorePlants(PLANTS, findings, { judge: judgeRealOnly });
    assert.equal(score.unsubstantiated, 1);
    assert.equal(score.falsePositives, 2);
    assert.ok(Math.abs(score.precision - 1 / 3) < 1e-9);
  });

  it('the JSON report carries the unsubstantiated count', () => {
    const report = buildJsonReport({
      recall: 0.25, caught: 1, total: 4, precision: 0.25, truePositives: 1,
      falsePositives: 3, unsubstantiated: 3, minRecall: 0, minPrecision: null,
      scorer: 'judge', commit: 'HEAD', reviewExitCode: 0, perCategory: {}, results: [],
    });
    assert.equal(report.unsubstantiated, 3);
  });

  it('a scorecard without the count reports zero unsubstantiated findings', () => {
    const report = buildJsonReport({
      recall: 1, caught: 1, total: 1, precision: 1, truePositives: 1, falsePositives: 0,
      minRecall: 0, minPrecision: null, scorer: 'judge', commit: 'HEAD', reviewExitCode: 0,
      perCategory: {}, results: [],
    });
    assert.equal(report.unsubstantiated, 0);
  });
});
