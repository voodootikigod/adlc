// gate-fuzzing/lib/clone.mjs
// Per-candidate disposable clone lifecycle (§1.7, Fix 2 — security-critical).
//
// Every candidate executes in a FRESH disposable git clone, NEVER in the real
// working tree. The lifecycle is:
//   1. cloneDir = mkdtempSync(...)
//   2. git clone --local --no-hardlinks <repo-root> <cloneDir>
//      (NOT plain --local: hardlinks share object inodes, so a forgery candidate
//       could corrupt the SOURCE repo's object store.)
//   3. apply candidate diff in cloneDir; run candidate setup steps in cloneDir
//   4. run gates + witness inside cloneDir UNDER THE SANDBOX (spawnCandidateCmd)
//   5. finally { rmSync(cloneDir, {recursive,force}) } — ALWAYS, even on throw
//
// Every harness git invocation is hardened with
//   -c core.hooksPath=/dev/null -c core.fsmonitor=false
// so a candidate's setup cannot plant a hook that runs at gate-time.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnCandidateCmd } from './sandbox.mjs';

// Hardening flags prepended to EVERY harness git invocation (Fix 2).
const GIT_HARDEN = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
];

/**
 * Run a hardened git command on the host (NOT under the OS sandbox — these are
 * harness-controlled, fixed-argv git calls, not candidate-supplied commands).
 * Always prefixes the hooks/fsmonitor hardening flags.
 *
 * @param {string[]} args - git subcommand + args (without leading 'git')
 * @param {{cwd?:string, timeout?:number, spawnFn?:Function}} opts
 * @returns {{exitCode:number, stdout:string, stderr:string}}
 */
export function hardenedGit(args, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawnSync;
  const fullArgs = [...GIT_HARDEN, ...args];
  const r = spawnFn('git', fullArgs, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 120_000,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
  });
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut: r.signal === 'SIGTERM' || r.status === null,
  };
}

/**
 * Provision a fresh disposable clone of repoRoot, apply the candidate's diff,
 * and run its setup steps. Returns the cloneDir. Caller MUST call destroyClone()
 * in a finally block.
 *
 * @param {object} candidate - { diff, setup }
 * @param {object} opts
 * @param {string} opts.repoRoot - source repo to clone
 * @param {string|null} opts.sandboxType - 'bwrap'|'sandbox-exec'|null
 * @param {boolean} [opts.unsafeNoSandbox]
 * @param {string} [opts.tmpRoot] - base for mkdtemp (default os.tmpdir())
 * @param {Function} [opts.spawnFn] - injectable spawnSync for tests
 * @param {Function} [opts.mkdtempFn] - injectable mkdtemp for tests
 * @param {number} [opts.timeout]
 * @returns {{cloneDir:string, setupResults:object[]}}
 */
export function provisionClone(candidate, opts) {
  const {
    repoRoot,
    sandboxType,
    unsafeNoSandbox = false,
    tmpRoot = tmpdir(),
    spawnFn,
    mkdtempFn = mkdtempSync,
    timeout = 120_000,
  } = opts;

  const cloneDir = mkdtempFn(join(tmpRoot, 'gf-clone-'));

  // 2. Disposable clone with --no-hardlinks (Fix 2). Hardened git.
  const clone = hardenedGit(
    ['clone', '--local', '--no-hardlinks', repoRoot, cloneDir],
    { spawnFn, timeout }
  );
  if (clone.exitCode !== 0) {
    // Clean up the empty temp dir before throwing.
    safeDestroy(cloneDir);
    throw new Error(
      `git clone --local --no-hardlinks failed (exit ${clone.exitCode}): ${clone.stderr.trim()}`
    );
  }

  // 3a. Apply the candidate diff inside the clone (hardened git apply).
  const setupResults = [];
  if (candidate.diff && candidate.diff.trim().length > 0) {
    const patchPath = join(cloneDir, '.gf-candidate.patch');
    writeFileSync(patchPath, ensureTrailingNewline(candidate.diff), 'utf8');
    const applied = hardenedGit(
      ['apply', '--whitespace=nowarn', patchPath],
      { cwd: cloneDir, spawnFn, timeout }
    );
    setupResults.push({ step: 'apply-diff', exitCode: applied.exitCode, stderr: applied.stderr });
    if (applied.exitCode !== 0) {
      // Diff did not apply cleanly — surface as a setup failure, not silently.
      return { cloneDir, setupResults, applyFailed: true };
    }
  }

  // 3b. Run candidate setup steps inside the clone, UNDER THE SANDBOX.
  // setup steps are candidate-supplied → they MUST be sandboxed.
  for (const step of (candidate.setup ?? [])) {
    const res = spawnCandidateCmd(step, cloneDir, {
      sandboxType,
      unsafeNoSandbox,
      cwd: cloneDir,
      timeout,
    });
    setupResults.push({
      step: step.join(' '),
      exitCode: res.exitCode,
      stderr: res.stderr,
      timedOut: res.timedOut,
    });
  }

  return { cloneDir, setupResults, applyFailed: false };
}

/**
 * Run a witness command UNDER THE SANDBOX.
 *
 * Write-confinement is ALWAYS the candidate clone (confineDir); the working dir
 * (chdir) is `targetDir`. For the candidate side, targetDir === confineDir. For
 * the BASELINE side, targetDir is the read-only baseline dir — writes there are
 * denied by the profile (only confineDir is writable), so the baseline witness
 * cannot mutate the real repo.
 *
 * @param {{cmd:string, args?:string[]}} witnessSpec
 * @param {string} targetDir - directory to run the witness against (chdir)
 * @param {object} opts - { sandboxType, unsafeNoSandbox, timeout, confineDir }
 * @returns {{status:number, timedOut:boolean}}
 */
export function runWitnessSandboxed(witnessSpec, targetDir, opts) {
  const confineDir = opts.confineDir ?? targetDir;
  const res = spawnCandidateCmd(
    [witnessSpec.cmd, ...(witnessSpec.args ?? [])],
    confineDir,
    {
      sandboxType: opts.sandboxType,
      unsafeNoSandbox: opts.unsafeNoSandbox,
      cwd: targetDir,
      workDir: targetDir,
      timeout: opts.timeout ?? 60_000,
    }
  );
  return { status: res.exitCode, timedOut: res.timedOut };
}

/**
 * Run a gate against the clone UNDER THE SANDBOX.
 * Gate run argv comes from the suite (harness-controlled), but it still executes
 * adversary-mutated code inside the clone, so it is sandboxed too.
 *
 * @param {string[]} gateArgv - [cmd, ...args]
 * @param {string} cloneDir
 * @param {object} opts - { sandboxType, unsafeNoSandbox, timeout }
 * @returns {{exitCode:number, stdout:string, stderr:string}}
 */
export function runGateSandboxed(gateArgv, cloneDir, opts) {
  return spawnCandidateCmd(gateArgv, cloneDir, {
    sandboxType: opts.sandboxType,
    unsafeNoSandbox: opts.unsafeNoSandbox,
    cwd: cloneDir,
    timeout: opts.timeout ?? 120_000,
  });
}

/**
 * Destroy a clone dir. Always safe to call (force, recursive). Never throws.
 * @param {string} cloneDir
 */
export function destroyClone(cloneDir) {
  safeDestroy(cloneDir);
}

function safeDestroy(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; never mask the original error
  }
}

function ensureTrailingNewline(s) {
  return s.endsWith('\n') ? s : s + '\n';
}
