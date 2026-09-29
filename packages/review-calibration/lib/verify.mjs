// review-calibration/lib/verify.mjs
// Behavioral verification. A witness is an input/test that PASSES on the
// original and FAILS on the mutant — it proves a plant is a real, reproducible
// bug (not an equivalent mutant). Witnesses come from the operator's plants
// file; nothing here runs a command authored by the reviewer under test.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tail } from '@adlc/core';
import { writeFileAtomic, NO_JOURNAL } from './inflight.mjs';

// Enough of a failing witness's output to show its failure line, small enough
// to print once per excluded plant.
const OUTPUT_TAIL = 1200;

/**
 * Run a witness command against the current working tree.
 * Convention: exit 0 = witness passes (behavior intact), non-zero = fails
 * (defect observable). `runFn` is injectable for tests.
 *
 * @param {{cmd:string, args?:string[]}} witnessSpec
 * @param {string} cwd
 * @param {Function} [runFn]  (cmd, args, cwd) => WitnessRun
 * @returns {{status:number|null, timedOut:boolean, output?:string, spawnError?:string|null}}
 */
export function runWitness(witnessSpec, cwd, runFn = defaultRun) {
  return runFn(witnessSpec.cmd, witnessSpec.args ?? [], cwd);
}

/**
 * A witness that could not be started (missing binary, EACCES, EAGAIN) has no
 * exit status either, so it is told apart from a timeout by spawnSync's error
 * code rather than by a null status.
 */
function defaultRun(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, timeout: 60_000, encoding: 'utf8', stdio: 'pipe', shell: false });
  const timedOut = r.error?.code === 'ETIMEDOUT' || (!r.error && r.signal === 'SIGTERM');
  const spawnError = r.error && !timedOut ? `${r.error.code ?? 'error'}: ${r.error.message}` : null;
  const output = tail(`${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), OUTPUT_TAIL);
  return { status: r.status, timedOut, output, spawnError };
}

/** Why a witness failed to discriminate, with the output that explains it. */
function nonDiscriminatingReason(onOriginal, onMutant) {
  const codes = `witness did not discriminate (original exit ${onOriginal.status}, mutant exit ${onMutant.status})`;
  // Red on the original means the witness itself is broken; its output is the
  // only thing that tells that apart from an equivalent mutant.
  if (onOriginal.status !== 0 && onOriginal.output) {
    return `${codes}; original run output: ${onOriginal.output}`;
  }
  return codes;
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
 * @param {object} [options]
 * @param {{begin:Function, end:Function}} [options.journal]  records the mutation
 *   before the file is written; begin throwing aborts before any write
 * @returns {{discriminates:boolean, reason:string}}
 */
export function verifyWitness(plant, cwd, runFn = defaultRun, { journal = NO_JOURNAL } = {}) {
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
  const mutated = lines.map((l, i) => (i === plant.line - 1 ? plant.mutated : l)).join('\n');
  journal.begin([{ absolutePath: plant.absolutePath, original, mutated }]);
  try {
    const { onMutant, onOriginal } = runBothSides(plant, cwd, runFn, { original, mutated });
    return judgeWitnessRuns(onOriginal, onMutant);
  } finally {
    if (restoreOriginal(plant.absolutePath, original)) journal.end();
  }
}

/** Run the witness on the mutant, then on the restored original. */
function runBothSides(plant, cwd, runFn, { original, mutated }) {
  writeFileAtomic(plant.absolutePath, mutated);
  const onMutant = runWitness(plant.witness, cwd, runFn);
  writeFileAtomic(plant.absolutePath, original);
  const onOriginal = runWitness(plant.witness, cwd, runFn);
  return { onMutant, onOriginal };
}

function restoreOriginal(absolutePath, original) {
  try {
    writeFileAtomic(absolutePath, original);
    return true;
  } catch {
    return false; // the in-flight record stays for the next run
  }
}

function judgeWitnessRuns(onOriginal, onMutant) {
  const spawnError = onOriginal.spawnError ?? onMutant.spawnError;
  if (spawnError) {
    return { discriminates: false, reason: `witness could not start (${spawnError})` };
  }
  if (onOriginal.timedOut || onMutant.timedOut) {
    return { discriminates: false, reason: 'witness timed out' };
  }
  const passesOriginal = onOriginal.status === 0;
  const failsMutant = onMutant.status !== 0;
  if (passesOriginal && failsMutant) return { discriminates: true, reason: 'ok' };
  return { discriminates: false, reason: nonDiscriminatingReason(onOriginal, onMutant) };
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
 * @param {object} [options]  passed to verifyWitness (journal)
 * @returns {{valid:Array, equivalent:Array}}
 */
export function filterEquivalentMutants(plants, cwd, runFn = defaultRun, options = {}) {
  const valid = [];
  const equivalent = [];
  for (const plant of plants) {
    if (!plant.witness) {
      valid.push({ ...plant, witnessed: false });
      continue;
    }
    const v = verifyWitness(plant, cwd, runFn, options);
    if (v.discriminates) valid.push({ ...plant, witnessed: true });
    else equivalent.push({ ...plant, reason: v.reason });
  }
  return { valid, equivalent };
}
