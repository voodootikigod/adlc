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
export async function findIdentifying(plant, located, { judge, verifyRepro }) {
  for (const f of located) {
    if (f.repro && verifyRepro) {
      if (await verifyRepro(plant, f)) return f;
      continue; // a repro that doesn't discriminate is not a catch
    }
    if (await judge(plant, f)) return f;
  }
  return null;
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
 *   precision, truePositives, falsePositives,
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

  for (const plant of plants) {
    const cat = plant.category ?? plant.operator ?? 'unknown';
    const located = locatingFindings(plant, findings, tolerance);
    const hit = located.length ? await findIdentifying(plant, located, deps) : null;
    const wasCaught = hit !== null;
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

  // Precision: a finding that locates NO plant (within tolerance) is spurious —
  // in a clean-base + only-our-plants tree, nothing else is broken.
  const falsePositives = countFalsePositives(findings, plants, tolerance);
  const truePositives = caught;
  const precisionDenom = truePositives + falsePositives;
  const precision = precisionDenom > 0 ? truePositives / precisionDenom : 1;

  return { recall, caught, total, precision, truePositives, falsePositives, perCategory, results };
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
