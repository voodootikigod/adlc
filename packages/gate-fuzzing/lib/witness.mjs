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
  const isTimeout = r.error?.code === 'ETIMEDOUT' || (!r.error && (r.signal === 'SIGTERM' || r.status === null));
  const spawnError = r.error && !isTimeout ? (r.error.code || r.error.message) : null;
  const timedOut = isTimeout;
  return {
    status: r.status,
    exitCode: r.status,
    timedOut,
    spawnError,
  };
}

/**
 * Judge or verify witness results between baseline and candidate.
 * Rejects spawn errors (e.g. ENOENT, EACCES) and shell launch failure exit codes (126, 127).
 *
 * @param {object} base - baseline run result or witnessSpec if called as (spec, dirs, opts)
 * @param {object} cand - candidate run result or dirs
 * @param {object} [opts]
 * @returns {{verified:boolean, discriminates:boolean, reason:string}}
 */
export function verifyWitness(base, cand, opts = {}) {
  if (base && typeof base === 'object' && ('cmd' in base || (cand && ('baselineDir' in cand || 'candidateDir' in cand)))) {
    return discriminateWitness(base, cand, opts);
  }

  const b = base ?? {};
  const c = cand ?? {};

  if (b.spawnError || c.spawnError) {
    const err = b.spawnError || c.spawnError;
    return {
      verified: false,
      discriminates: false,
      reason: `witness could not start (${err})`,
    };
  }

  if (
    b.exitCode === 126 || b.exitCode === 127 ||
    c.exitCode === 126 || c.exitCode === 127 ||
    b.status === 126 || b.status === 127 ||
    c.status === 126 || c.status === 127
  ) {
    const code = [b.exitCode, c.exitCode, b.status, c.status].find((s) => s === 126 || s === 127);
    return {
      verified: false,
      discriminates: false,
      reason: `shell launch failure, exit ${code}`,
    };
  }

  if (b.timedOut || c.timedOut) {
    return {
      verified: false,
      discriminates: false,
      reason: 'inconclusive',
    };
  }

  const baseCode = b.exitCode ?? b.status;
  const candCode = c.exitCode ?? c.status;

  if (baseCode === 0 && Number.isInteger(candCode) && candCode > 0) {
    return {
      verified: true,
      discriminates: true,
      reason: 'ok',
    };
  }

  return {
    verified: false,
    discriminates: false,
    reason: baseCode !== 0
      ? `baseline failed (exit ${baseCode})`
      : `candidate passed or did not exit with a positive status (exit ${candCode})`,
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
 * @returns {{discriminates:boolean, verified:boolean, reason:string}}
 */
export function discriminateWitness(witnessSpec, dirs, opts = {}) {
  const { baselineDir, candidateDir } = dirs;
  const trials = opts.trials ?? 3;
  const runFn = opts.runFn ?? defaultRunFn;

  // Run N trials on baseline — must ALL exit 0
  for (let i = 0; i < trials; i++) {
    const r = runFn(witnessSpec, baselineDir);
    if (r.spawnError) {
      return {
        discriminates: false,
        verified: false,
        reason: `witness could not start on baseline (${r.spawnError})`,
      };
    }
    const exitCode = r.exitCode ?? r.status;
    if (exitCode === 126 || exitCode === 127) {
      return {
        discriminates: false,
        verified: false,
        reason: `shell launch failure on baseline, exit ${exitCode}`,
      };
    }
    if (r.timedOut) {
      return { discriminates: false, verified: false, reason: 'inconclusive' };
    }
    if (exitCode !== 0) {
      return {
        discriminates: false,
        verified: false,
        reason: `inconclusive: baseline trial ${i + 1} failed (exit ${exitCode}) — witness is flaky on baseline`,
      };
    }
  }

  // Run N trials on candidate — must ALL exit with a positive integer status
  for (let i = 0; i < trials; i++) {
    const r = runFn(witnessSpec, candidateDir);
    if (r.spawnError) {
      return {
        discriminates: false,
        verified: false,
        reason: `witness could not start on candidate (${r.spawnError})`,
      };
    }
    const exitCode = r.exitCode ?? r.status;
    if (exitCode === 126 || exitCode === 127) {
      return {
        discriminates: false,
        verified: false,
        reason: `shell launch failure on candidate, exit ${exitCode}`,
      };
    }
    if (r.timedOut) {
      return { discriminates: false, verified: false, reason: 'inconclusive' };
    }
    if (!Number.isInteger(exitCode) || exitCode <= 0) {
      return {
        discriminates: false,
        verified: false,
        reason: exitCode === 0
          ? `inconclusive: candidate trial ${i + 1} passed (exit 0) — witness is flaky on candidate`
          : `inconclusive: candidate trial ${i + 1} did not exit with a positive status (${exitCode})`,
      };
    }
  }

  return { discriminates: true, verified: true, reason: 'ok' };
}
