import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scorePlants, identifyingFindings, DEFAULT_LLM_CONCURRENCY as SCORER_CONCURRENCY } from '../lib/scorer.mjs';
import { calibrateJudge, DEFAULT_LLM_CONCURRENCY as JUDGE_CONCURRENCY } from '../lib/judge.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('scorePlants and identifyingFindings bound concurrent judge calls and preserve order', async () => {
  assert.equal(SCORER_CONCURRENCY, 4);
  const plants = Array.from({ length: 6 }, (_, i) => ({
    file: `src/file${i}.mjs`,
    line: 10,
    operator: 'cond',
    category: 'logic',
    defect: `defect ${i}`,
    original: 'a === b',
    mutated: 'a !== b',
  }));
  const findings = plants.map((p, i) => ({
    file: p.file,
    line: 10,
    description: `caught ${i}`,
    evidence: '',
  }));

  let inFlight = 0;
  let maxInFlight = 0;
  const score = await scorePlants(plants, findings, {
    concurrency: 2,
    judge: async (plant) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      const idx = Number(plant.file.match(/\d+/)[0]);
      await delay((6 - idx) * 6);
      inFlight--;
      return idx % 2 === 0;
    },
  });

  assert.equal(maxInFlight, 2);
  assert.equal(score.caught, 3);
  assert.equal(score.total, 6);
  assert.deepEqual(score.results.map((r) => r.file), plants.map((p) => p.file));
  assert.deepEqual(score.results.map((r) => r.caught), [true, false, true, false, true, false]);

  // identifyingFindings preserves locating order under concurrency.
  const hits = await identifyingFindings(plants[0], findings.slice(0, 4), {
    concurrency: 2,
    judge: async (_plant, finding) => {
      await delay(5);
      return finding.description === 'caught 0' || finding.description === 'caught 2';
    },
  });
  assert.deepEqual(hits.map((h) => h.description), ['caught 0', 'caught 2']);

  // Fail-fast on judge error.
  await assert.rejects(
    () => scorePlants(plants, findings, {
      concurrency: 2,
      judge: async () => { throw new Error('judge-down'); },
    }),
    /judge-down/,
  );
});

test('calibrateJudge bounds concurrent judge calls, preserves disagreement order, and propagates errors', async () => {
  assert.equal(JUDGE_CONCURRENCY, 4);
  const fixture = Array.from({ length: 6 }, (_, i) => ({
    plant: { file: `p${i}.mjs`, line: i + 1 },
    finding: { file: `f${i}.mjs`, line: i + 1 },
    expected: i % 2 === 0,
  }));

  let inFlight = 0;
  let maxInFlight = 0;
  const cal = await calibrateJudge(fixture, async (plant) => {
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    const idx = Number(plant.file.match(/\d+/)[0]);
    await delay((6 - idx) * 6);
    inFlight--;
    // Disagree on indices 1 and 4.
    if (idx === 1) return true;
    if (idx === 4) return false;
    return idx % 2 === 0;
  }, { concurrency: 2 });

  assert.equal(maxInFlight, 2);
  assert.equal(cal.n, 6);
  assert.equal(cal.agreement, 4 / 6);
  assert.deepEqual(cal.disagreements.map((d) => d.plant), ['p1.mjs', 'p4.mjs']);

  // Invalid concurrency falls back cleanly.
  const fallback = await calibrateJudge(fixture.slice(0, 1), async () => true, { concurrency: 0 });
  assert.equal(fallback.agreement, 1);

  // Error propagates.
  await assert.rejects(
    () => calibrateJudge(fixture, async () => { throw new Error('cal-boom'); }, { concurrency: 2 }),
    /cal-boom/,
  );
});
