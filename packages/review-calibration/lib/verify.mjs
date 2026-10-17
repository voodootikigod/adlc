// review-calibration/lib/verify.mjs
// Behavioral verification. A witness is an input/test that PASSES on the
// original and FAILS on the mutant — it proves a plant is a real, reproducible
// bug (not an equivalent mutant). Witnesses come from the operator's plants
// file; nothing here runs a command authored by the reviewer under test.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { checkSyntax, syntaxLanguage, tail } from '@adlc/core';
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

// Exit statuses a shell reports when it could not launch the command at all
// (126 found but not executable, 127 not found). Nothing was tested.
const LAUNCH_FAILURE_STATUSES = new Set([126, 127]);

/**
 * Classify one witness run. A run that never launched is not a failing test,
 * so it must not be read as the mutant being caught.
 *
 * @param {{status:number|null, timedOut?:boolean, spawnError?:string|null}} run
 * @returns {'completed'|'timeout'|'spawn-failed'}
 */
export function classifyWitnessRun(run) {
  if (run.spawnError || LAUNCH_FAILURE_STATUSES.has(run.status)) return 'spawn-failed';
  if (run.timedOut) return 'timeout';
  return 'completed';
}

/**
 * Classify a `node --check` result. A checker that did not run to a normal exit
 * (spawn error, signal, no status) proves nothing about the file, so only a
 * real exit status decides. @adlc/core's checkSyntax applies this same rule to
 * JavaScript; TypeScript-family workers have their own exit codes, so callers
 * must not use this classifier for TypeScript.
 *
 * @param {{error?:unknown, signal?:string|null, status:number|null}} r
 * @returns {'valid'|'invalid'|'unknown'}
 */
export function classifySyntaxResult(r) {
  if (r.error || r.signal || typeof r.status !== 'number') return 'unknown';
  return r.status === 0 ? 'valid' : 'invalid';
}

/** The plant's file contents with only its line replaced, or null if it drifted. */
function mutatedSource(plant, original) {
  const lines = original.split('\n');
  if (lines[plant.line - 1] !== plant.original) return null;
  return lines.map((l, i) => (i === plant.line - 1 ? plant.mutated : l)).join('\n');
}

/**
 * Does the mutated file parse? Applied inside the in-flight journal like any
 * other write, restored before returning. Anything that prevents a verdict
 * (unsupported file, unreadable or drifted file, checker failure) is 'unknown'
 * — the plant keeps today's treatment and records that it was never
 * syntax-checked.
 *
 * @returns {'valid'|'invalid'|'unknown'}
 */
function checkPlantSyntax(plant, cwd, { journal = NO_JOURNAL, syntaxFn = checkSyntax } = {}) {
  if (syntaxLanguage(plant.absolutePath) === null) return 'unknown';
  let original;
  try {
    original = readFileSync(plant.absolutePath, 'utf8');
  } catch {
    return 'unknown';
  }
  const mutated = mutatedSource(plant, original);
  if (mutated === null) return 'unknown';
  journal.begin([{ absolutePath: plant.absolutePath, original, mutated }]);
  try {
    writeFileAtomic(plant.absolutePath, mutated);
    return syntaxFn(plant.absolutePath, cwd);
  } finally {
    if (restoreOriginal(plant.absolutePath, original)) journal.end();
  }
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
  const mutated = mutatedSource(plant, original);
  if (mutated === null) {
    return { discriminates: false, reason: 'original drifted — refusing to verify' };
  }
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
  const failed = [onOriginal, onMutant].find((run) => classifyWitnessRun(run) === 'spawn-failed');
  if (failed) {
    const why = failed.spawnError ?? `shell launch failure, exit ${failed.status}`;
    return { discriminates: false, kind: 'spawn-failed', reason: `witness could not start (${why})` };
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
 * Partition plants into { valid, equivalent, discarded }.
 * - `discarded`: never valid test cases — the mutant does not parse
 *   (kind 'unparseable') or the witness never launched (kind 'spawn-failed').
 *   Neither says anything about whether a reviewer could catch the plant.
 * - `equivalent`: a witnessed plant whose witness ran but did not discriminate.
 * - `valid`: everything else. Plants WITHOUT a witness pass through flagged
 *   `witnessed:false` (they fall to semantic judging, not behavioral) — absence
 *   of a witness is unknown-ness, not equivalence. Every valid plant carries
 *   `syntax` ('valid' | 'unknown').
 * Only `valid` plants enter the recall denominator.
 *
 * @param {Array<object>} plants
 * @param {string} cwd
 * @param {Function} [runFn]
 * @param {object} [options]  journal, and syntaxFn for tests
 * @returns {{valid:Array, equivalent:Array, discarded:Array}}
 */
export function filterEquivalentMutants(plants, cwd, runFn = defaultRun, options = {}) {
  const valid = [];
  const equivalent = [];
  const discarded = [];
  for (const plant of plants) {
    const syntax = checkPlantSyntax(plant, cwd, options);
    if (syntax === 'invalid') {
      discarded.push({ ...plant, kind: 'unparseable', reason: 'mutant does not parse' });
      continue;
    }
    if (!plant.witness) {
      valid.push({ ...plant, witnessed: false, syntax });
      continue;
    }
    const v = verifyWitness(plant, cwd, runFn, options);
    if (v.discriminates) valid.push({ ...plant, witnessed: true, syntax });
    else if (v.kind === 'spawn-failed') discarded.push({ ...plant, kind: v.kind, reason: v.reason });
    else equivalent.push({ ...plant, reason: v.reason });
  }
  return { valid, equivalent, discarded };
}
