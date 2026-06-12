// gate-fuzzing/lib/provision.mjs
// Builds the per-candidate provisionFn the loop uses to execute candidates in a
// fresh disposable clone under the sandbox (Fix 2 wiring).
//
// The provisionFn returns:
//   { cloneDir, runGateFn, runWitnessFn, oracleFn, destroy, error? }
// The loop ALWAYS calls destroy() in a finally block.

import {
  provisionClone,
  destroyClone,
  runWitnessSandboxed,
  runGateSandboxed,
} from './clone.mjs';
import { substituteTokens } from './gate-adapter.mjs';
import { checkOracle } from './oracle.mjs';

/**
 * Build a provisionFn bound to a repo root, sandbox type, and suite.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - source repo to clone from
 * @param {string|null} opts.sandboxType - 'bwrap'|'sandbox-exec'|null
 * @param {boolean} [opts.unsafeNoSandbox]
 * @param {object[]} opts.suite - gate descriptors (with .run argv templates)
 * @param {string} opts.baselineRef - baseline ref for gate token substitution
 * @param {Function|null} [opts.independentApprovalFn] - behavioral oracle lens (b)
 * @param {number} [opts.timeout]
 * @returns {Function} async (candidate) => provisioned
 */
export function makeProvisionFn(opts) {
  const {
    repoRoot,
    sandboxType,
    unsafeNoSandbox = false,
    suite,
    baselineRef = 'HEAD',
    independentApprovalFn = null,
    timeout = 120_000,
  } = opts;

  return async function provision(candidate) {
    let cloneDir = null;
    try {
      const provisioned = provisionClone(candidate, {
        repoRoot,
        sandboxType,
        unsafeNoSandbox,
        timeout,
      });
      cloneDir = provisioned.cloneDir;

      if (provisioned.applyFailed) {
        return {
          cloneDir,
          error: 'candidate diff did not apply cleanly',
          destroy: () => destroyClone(cloneDir),
        };
      }

      // Gate runner bound to THIS clone, under the sandbox.
      const runGateFn = (gateName) => {
        const gate = suite.find((g) => g.name === gateName);
        if (!gate || !Array.isArray(gate.run) || gate.run.length === 0) {
          // Misconfigured gate → treat as inconclusive (exit 1).
          return { exitCode: 1 };
        }
        const argv = substituteTokens(gate.run, {
          clone: cloneDir,
          baseline: baselineRef,
        });
        const r = runGateSandboxed(argv, cloneDir, {
          sandboxType,
          unsafeNoSandbox,
          timeout,
        });
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      };

      // Witness runner bound to THIS clone, under the sandbox.
      // The baseline side is the user's repo root (read-only is fine — we never
      // mutate it), but it too runs under the sandbox confined to its own dir.
      const runWitnessFn = (witnessSpec, dir) => {
        return runWitnessSandboxed(witnessSpec, dir, {
          sandboxType,
          unsafeNoSandbox,
          confineDir: cloneDir, // writes ALWAYS confined to the candidate clone
          timeout,
        });
      };

      // Oracle: contract-derived by default for contract gates; behavioral lens (b)
      // only when an approval fn is supplied.
      const oracleFn = (cand) => {
        const witnessSource = cand.witnessSource ?? 'proposed';
        return checkOracle({
          candidate: cand,
          witnessSource,
          independentApprovalFn,
        });
      };

      return {
        cloneDir,
        runGateFn,
        runWitnessFn,
        oracleFn,
        destroy: () => destroyClone(cloneDir),
      };
    } catch (e) {
      // Provisioning blew up (e.g. no sandbox + no --unsafe). Surface as error and
      // make sure any partial clone is destroyed.
      const dir = cloneDir;
      return {
        cloneDir: dir,
        error: e.message,
        destroy: () => destroyClone(dir),
      };
    }
  };
}
