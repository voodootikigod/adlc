// review-calibration/lib/scorer.mjs
// Score reviewer findings against planted defects. A plant is CAUGHT only when
// a finding LOCATES it AND identifies the defect — judged semantically, or, for
// a library caller that injects `verifyRepro`, verified behaviorally by the
// finding's own repro. There is deliberately NO "output contains a substring of the
// changed line" shortcut: that is exactly what let a line-echoing reviewer
// score 1.0. Pure aggregation; the hard semantic call is delegated to `judge`.

const DEFAULT_TOLERANCE = 3;
export const DEFAULT_LLM_CONCURRENCY = 4;

async function mapWithConcurrency(items, concurrency, fn) {
  const limit = Number.isInteger(concurrency) && concurrency >= 1
    ? concurrency
    : DEFAULT_LLM_CONCURRENCY;
  const out = new Array(items.length);
  let nextIdx = 0;
  let firstError = null;

  async function worker() {
    while (firstError === null && nextIdx < items.length) {
      const idx = nextIdx++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (err) {
        if (firstError === null) firstError = err;
        return;
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError !== null) throw firstError;
  return out;
}

function normalizeRelPath(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function pathsMatch(plantFile, findingFile) {
  const pf = normalizeRelPath(plantFile);
  const ff = normalizeRelPath(findingFile);
  if (!pf || !ff) return false;
  if (pf === ff) return true;
  if (!ff.includes('/')) return pf.endsWith('/' + ff);
  const isAbs = ff.startsWith('/') || /^[a-zA-Z]:\//.test(ff);
  return isAbs && ff.endsWith('/' + pf);
}

/** Findings whose normalized repo-relative path matches and line is within tolerance of the plant. */
export function locatingFindings(plant, findings, tolerance = DEFAULT_TOLERANCE) {
  return findings.filter(
    (f) => pathsMatch(plant.file, f.file) && Math.abs(f.line - plant.line) <= tolerance
  );
}

/**
 * Does one locating finding identify the plant's defect? A runnable repro is
 * decisive when a `verifyRepro` is supplied (a repro that does not
 * discriminate is not a catch); otherwise the judge decides.
 *
 * @returns {Promise<boolean>}
 */
async function identifies(plant, finding, { judge, verifyRepro }) {
  if (finding.repro && verifyRepro) return Boolean(await verifyRepro(plant, finding));
  return Boolean(await judge(plant, finding));
}

/**
 * Decide whether any locating finding identifies the plant's defect.
 * Per finding: a runnable repro that discriminates (model-free) wins outright;
 * otherwise the judge decides. Returns the matching finding or null.
 *
 * @param {object} plant
 * @param {Array<object>} located         findings that already locate the plant
 * @param {object} deps
 * @param {(plant, finding)=>(boolean|Promise<boolean>)} deps.judge
 * @param {(plant, finding)=>(boolean|Promise<boolean>)} [deps.verifyRepro]  behavioral check for finding.repro
 * @returns {Promise<object|null>}
 */
export async function findIdentifying(plant, located, deps) {
  for (const f of located) {
    if (await identifies(plant, f, deps)) return f;
  }
  return null;
}

/**
 * Every locating finding that identifies the plant's defect. Each finding gets
 * its own verdict, because precision needs one: a finding that locates a plant
 * but identifies nothing is an unsubstantiated claim, wherever it sits in the
 * reviewer's output.
 *
 * @returns {Promise<Array<object>>}
 */
export async function identifyingFindings(plant, located, deps) {
  const concurrency = deps?.concurrency ?? DEFAULT_LLM_CONCURRENCY;
  const verdicts = await mapWithConcurrency(located, concurrency, (f) => identifies(plant, f, deps));
  return located.filter((_, i) => verdicts[i]);
}

/**
 * Score the full plant list against parsed findings.
 *
 * @param {Array<{file,line,operator,category,defect,original,mutated}>} plants
 * @param {Array<{file,line,description,evidence,repro?}>} findings
 * @param {object} deps
 * @param {(plant,finding)=>(boolean|Promise<boolean>)} deps.judge   REQUIRED
 * @param {(plant,finding)=>(boolean|Promise<boolean>)} [deps.verifyRepro]
 * @param {number} [deps.tolerance]
 * @param {number} [deps.concurrency]
 * @returns {Promise<{
 *   recall, caught, total,
 *   precision, truePositives, falsePositives, unsubstantiated,
 *   perCategory, results
 * }>}
 */
export async function scorePlants(plants, findings, deps) {
  if (typeof deps?.judge !== 'function') {
    throw new Error('scorePlants requires a judge function — refusing to fall back to string matching');
  }
  const tolerance = deps.tolerance ?? DEFAULT_TOLERANCE;
  const concurrency = deps.concurrency ?? DEFAULT_LLM_CONCURRENCY;
  const perCategory = {};
  const results = [];
  let caught = 0;
  const locatedSome = new Set();
  const identifiedSome = new Set();

  // Flatten all (plantIndex, finding) judgments through a single bounded pool
  // so total in-flight LLM calls never exceed `concurrency`.
  const locatedByPlant = plants.map((plant) => locatingFindings(plant, findings, tolerance));
  const pairs = [];
  for (let pi = 0; pi < plants.length; pi++) {
    for (const f of locatedByPlant[pi]) {
      pairs.push({ pi, plant: plants[pi], finding: f });
    }
  }
  const pairVerdicts = await mapWithConcurrency(
    pairs,
    concurrency,
    ({ plant, finding }) => identifies(plant, finding, deps),
  );
  const hitsByPlant = plants.map(() => []);
  for (let i = 0; i < pairs.length; i++) {
    if (pairVerdicts[i]) hitsByPlant[pairs[i].pi].push(pairs[i].finding);
  }

  for (let pi = 0; pi < plants.length; pi++) {
    const plant = plants[pi];
    const cat = plant.category ?? plant.operator ?? 'unknown';
    const located = locatedByPlant[pi];
    const hits = hitsByPlant[pi];
    for (const f of located) locatedSome.add(f);
    for (const f of hits) identifiedSome.add(f);
    const wasCaught = hits.length > 0;
    if (wasCaught) caught++;

    results.push({
      file: plant.file,
      line: plant.line,
      operator: plant.operator ?? cat,
      category: cat,
      caught: wasCaught,
      original: plant.original,
      mutated: plant.mutated,
    });

    if (!perCategory[cat]) perCategory[cat] = { caught: 0, total: 0, recall: 0 };
    perCategory[cat].total++;
    if (wasCaught) perCategory[cat].caught++;
  }

  for (const c of Object.values(perCategory)) {
    c.recall = c.total > 0 ? c.caught / c.total : 0;
  }

  const total = plants.length;
  const recall = total > 0 ? caught / total : 0;

  // Precision. A false positive is a finding that locates NO plant (in a
  // clean-base + only-our-plants tree nothing else is broken), or one that
  // locates a plant but identifies no plant's defect — an unsubstantiated
  // claim, such as an echo of the changed line.
  const unsubstantiated = [...locatedSome].filter((f) => !identifiedSome.has(f)).length;
  const falsePositives = countFalsePositives(findings, plants, tolerance) + unsubstantiated;
  const truePositives = caught;
  const precisionDenom = truePositives + falsePositives;
  const precision = precisionDenom > 0 ? truePositives / precisionDenom : null;

  return {
    recall, caught, total, precision, truePositives, falsePositives, unsubstantiated,
    perCategory, results,
  };
}

/**
 * Count findings that locate no plant within tolerance (spurious flags).
 *
 * @param {Array<{file,line}>} findings
 * @param {Array<{file,line}>} plants
 * @param {number} [tolerance]
 * @returns {number}
 */
export function countFalsePositives(findings, plants, tolerance = DEFAULT_TOLERANCE) {
  let fp = 0;
  for (const f of findings) {
    const matches = plants.some(
      (p) => pathsMatch(p.file, f.file) && Math.abs(p.line - f.line) <= tolerance
    );
    if (!matches) fp++;
  }
  return fp;
}
