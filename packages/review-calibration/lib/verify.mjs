// review-calibration/lib/verify.mjs
// Behavioral verification. A witness is an input/test that PASSES on the
// original and FAILS on the mutant — it proves a plant is a real, reproducible
// bug (not an equivalent mutant) and, when a reviewer supplies its own repro,
// lets a finding be confirmed model-free ("reproduce or kill").

import { writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Run a witness command against the current working tree.
 * Convention: exit 0 = witness passes (behavior intact), non-zero = fails
 * (defect observable). `runFn` is injectable for tests.
 *
 * @param {{cmd:string, args?:string[]}} witnessSpec
 * @param {string} cwd
 * @param {Function} [runFn]  (cmd, args, cwd) => { status:number, timedOut:boolean }
 * @returns {{status:number, timedOut:boolean}}
 */
export function runWitness(witnessSpec, cwd, runFn = defaultRun) {
  return runFn(witnessSpec.cmd, witnessSpec.args ?? [], cwd);
}

function defaultRun(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, timeout: 60_000, encoding: 'utf8', stdio: 'pipe', shell: false });
  return { status: r.status, timedOut: r.signal === 'SIGTERM' || r.status === null };
}

/**
 * Confirm a single plant's witness discriminates mutant from original:
 * apply ONLY this plant to a clean file, witness must FAIL; restore, witness
 * must PASS. Anything else means the witness is bad or the mutant is
 * equivalent (no observable behavior change). Per-plant isolation avoids
 * interference between simultaneously-applied plants.
 *
 * @param {{absolutePath:string, line:number, original:string, mutated:string, witness?:object}} plant
 * @param {string} cwd
 * @param {Function} [runFn]
 * @returns {{discriminates:boolean, reason:string}}
 */
export function verifyWitness(plant, cwd, runFn = defaultRun) {
  if (!plant.witness) return { discriminates: false, reason: 'no witness' };
  let original;
  try {
    original = readFileSync(plant.absolutePath, 'utf8');
  } catch (err) {
    return { discriminates: false, reason: `cannot read ${plant.absolutePath}: ${err.message}` };
  }
  const lines = original.split('\n');
  if (lines[plant.line - 1] !== plant.original) {
    return { discriminates: false, reason: 'original drifted — refusing to verify' };
  }
  try {
    // Mutant must fail.
    lines[plant.line - 1] = plant.mutated;
    writeFileSync(plant.absolutePath, lines.join('\n'), 'utf8');
    const onMutant = runWitness(plant.witness, cwd, runFn);
    // Original must pass.
    writeFileSync(plant.absolutePath, original, 'utf8');
    const onOriginal = runWitness(plant.witness, cwd, runFn);

    if (onOriginal.timedOut || onMutant.timedOut) {
      return { discriminates: false, reason: 'witness timed out' };
    }
    const passesOriginal = onOriginal.status === 0;
    const failsMutant = onMutant.status !== 0;
    if (passesOriginal && failsMutant) return { discriminates: true, reason: 'ok' };
    return {
      discriminates: false,
      reason: `witness did not discriminate (original exit ${onOriginal.status}, mutant exit ${onMutant.status})`,
    };
  } finally {
    try {
      writeFileSync(plant.absolutePath, original, 'utf8');
    } catch {
      // best effort
    }
  }
}

/**
 * Partition plants into { valid, equivalent } by witness discrimination.
 * Plants WITHOUT a witness pass through as `valid` but flagged
 * `witnessed:false` (they fall to semantic judging, not behavioral) — they are
 * NOT dropped, because absence of a witness is unknown-ness, not equivalence.
 * Plants WITH a witness that fails to discriminate are `equivalent` and
 * excluded from the recall denominator (scoring an unfindable bug as "missed"
 * dishonestly deflates recall).
 *
 * @param {Array<object>} plants
 * @param {string} cwd
 * @param {Function} [runFn]
 * @returns {{valid:Array, equivalent:Array}}
 */
export function filterEquivalentMutants(plants, cwd, runFn = defaultRun) {
  const valid = [];
  const equivalent = [];
  for (const plant of plants) {
    if (!plant.witness) {
      valid.push({ ...plant, witnessed: false });
      continue;
    }
    const v = verifyWitness(plant, cwd, runFn);
    if (v.discriminates) valid.push({ ...plant, witnessed: true });
    else equivalent.push({ ...plant, reason: v.reason });
  }
  return { valid, equivalent };
}
