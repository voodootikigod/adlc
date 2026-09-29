// review-calibration/lib/scorer.mjs
// Score reviewer findings against planted defects. A plant is CAUGHT only when
// a finding LOCATES it AND identifies the defect — verified behaviorally (the
// finding's own repro discriminates mutant from original) or judged
// semantically. There is deliberately NO "output contains a substring of the
// changed line" shortcut: that is exactly what let a line-echoing reviewer
// score 1.0. Pure aggregation; the hard semantic call is delegated to `judge`.

import { basename } from 'node:path';

const DEFAULT_TOLERANCE = 3;

/** Findings whose file basename matches and line is within tolerance of the plant. */
export function locatingFindings(plant, findings, tolerance = DEFAULT_TOLERANCE) {
  const base = basename(plant.file);
  return findings.filter(
    (f) => basename(f.file) === base && Math.abs(f.line - plant.line) <= tolerance
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
  const hits = [];
  for (const f of located) {
    if (await identifies(plant, f, deps)) hits.push(f);
  }
  return hits;
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
  const perCategory = {};
  const results = [];
  let caught = 0;
  const locatedSome = new Set();
  const identifiedSome = new Set();

  for (const plant of plants) {
    const cat = plant.category ?? plant.operator ?? 'unknown';
    const located = locatingFindings(plant, findings, tolerance);
    const hits = located.length ? await identifyingFindings(plant, located, deps) : [];
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
    const fBase = basename(f.file);
    const matches = plants.some(
      (p) => basename(p.file) === fBase && Math.abs(p.line - f.line) <= tolerance
    );
    if (!matches) fp++;
  }
  return fp;
}
