// gate-fuzzing/lib/witness.mjs
// Tree-level witness discrimination: N-trial unanimous rule (§1.4, F3/F8).
// Re-implements the runWitness exit-0 convention locally (§13.1).
// NOT imported from review-calibration — each tool stands alone.

import { spawnSync } from 'node:child_process';

/**
 * Run a witness command against a directory.
 * Convention: exit 0 = witness passes (behavior intact), non-zero = defect observable.
 * runFn is injectable for tests.
 *
 * @param {{cmd:string, args?:string[]}} witnessSpec
 * @param {string} cwd
 * @param {Function} [runFn]  (spec, cwd) => {status:number, timedOut:boolean}
 * @returns {{status:number, timedOut:boolean}}
 */
export function runWitness(witnessSpec, cwd, runFn = defaultRunFn) {
  return runFn(witnessSpec, cwd);
}

function defaultRunFn(witnessSpec, cwd) {
  const r = spawnSync(witnessSpec.cmd, witnessSpec.args ?? [], {
    cwd,
    timeout: 60_000,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
  });
  return {
    status: r.status,
    timedOut: r.signal === 'SIGTERM' || r.status === null,
  };
}

/**
 * Discriminate a witness across N trials on both baseline and candidate trees.
 * Discriminates IFF: ALL baseline runs exit 0 AND ALL candidate runs exit non-0,
 * and none timed out. Any flake → inconclusive (F8).
 *
 * @param {{cmd:string, args?:string[]}} witnessSpec
 * @param {{baselineDir:string, candidateDir:string}} dirs
 * @param {{trials:number, runFn?:Function}} opts
 * @returns {{discriminates:boolean, reason:string}}
 */
export function discriminateWitness(witnessSpec, dirs, opts = {}) {
  const { baselineDir, candidateDir } = dirs;
  const trials = opts.trials ?? 3;
  const runFn = opts.runFn ?? defaultRunFn;

  // Run N trials on baseline — must ALL exit 0
  for (let i = 0; i < trials; i++) {
    const r = runFn(witnessSpec, baselineDir);
    if (r.timedOut) {
      return { discriminates: false, reason: 'inconclusive' };
    }
    if (r.status !== 0) {
      return {
        discriminates: false,
        reason: `inconclusive: baseline trial ${i + 1} failed (exit ${r.status}) — witness is flaky on baseline`,
      };
    }
  }

  // Run N trials on candidate — must ALL exit non-0
  for (let i = 0; i < trials; i++) {
    const r = runFn(witnessSpec, candidateDir);
    if (r.timedOut) {
      return { discriminates: false, reason: 'inconclusive' };
    }
    if (r.status === 0) {
      return {
        discriminates: false,
        reason: `inconclusive: candidate trial ${i + 1} passed (exit 0) — witness is flaky on candidate`,
      };
    }
  }

  return { discriminates: true, reason: 'ok' };
}
