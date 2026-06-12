// gate-fuzzing/lib/sandbox.mjs
// OS sandbox integration (§1.7, F6 — fix 1).
// Implements BOTH bwrap (Linux) and sandbox-exec (macOS) concretely.
// Refuses to run without sandbox unless --unsafe-no-sandbox is passed.

import { spawnSync } from 'node:child_process';

export const SANDBOX_PROFILES = {
  bwrap: {
    binary: 'bwrap',
    description: 'Linux bubblewrap sandbox (unshares all namespaces, denies network)',
  },
  'sandbox-exec': {
    binary: 'sandbox-exec',
    description: 'macOS sandbox-exec with SBPL profile (denies network, write-confined to clone)',
  },
};

/**
 * Detect which sandbox binary is available.
 * @param {{which?:Function}} opts - injectable for tests
 * @returns {'bwrap'|'sandbox-exec'|null}
 */
export function detectSandbox(opts = {}) {
  const whichFn = opts.which ?? defaultWhich;

  if (whichFn('bwrap')) return 'bwrap';
  if (whichFn('sandbox-exec')) return 'sandbox-exec';
  return null;
}

function defaultWhich(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8', stdio: 'pipe' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Build the macOS SBPL sandbox profile.
 * Deny default, allow process execution, allow file reads everywhere,
 * deny all network, allow writes only inside cloneDir.
 *
 * @param {string} cloneDir
 * @returns {string} SBPL profile string
 */
export function buildMacOSSbpl(cloneDir) {
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow file-read*)',
    '(deny network*)',
    `(allow file-write* (subpath "${cloneDir}"))`,
    '(allow file-write-data (path "/dev/null"))',
  ].join('');
}

/**
 * Build sandboxed argv for running a command inside the sandbox.
 *
 * Fix 1 implementation:
 * - bwrap: --unshare-all --ro-bind / / --bind <cloneDir> <cloneDir>
 *          --dev /dev --proc /proc --die-with-parent --new-session
 *          --chdir <cloneDir> -- <cmd> <args>
 *          (no --share-net: network unshared/denied)
 * - sandbox-exec: -p '<SBPL>' <cmd> <args>
 *
 * @param {'bwrap'|'sandbox-exec'} sandboxType
 * @param {string} cloneDir - the ONLY writable subpath
 * @param {string[]} cmdArgs - [cmd, ...args]
 * @param {{workDir?:string}} [opts] - chdir target (default cloneDir). Lets the
 *        baseline witness chdir into the read-only baseline dir while writes stay
 *        confined to cloneDir.
 * @returns {string[]} Full argv including sandbox binary and args
 */
export function buildSandboxedArgs(sandboxType, cloneDir, cmdArgs, opts = {}) {
  const workDir = opts.workDir ?? cloneDir;
  if (sandboxType === 'bwrap') {
    return [
      'bwrap',
      '--unshare-all',
      '--ro-bind', '/', '/',
      '--bind', cloneDir, cloneDir,
      '--dev', '/dev',
      '--proc', '/proc',
      '--die-with-parent',
      '--new-session',
      '--chdir', workDir,
      '--',
      ...cmdArgs,
    ];
  }

  if (sandboxType === 'sandbox-exec') {
    const sbpl = buildMacOSSbpl(cloneDir);
    return [
      'sandbox-exec',
      '-p', sbpl,
      ...cmdArgs,
    ];
  }

  throw new Error(`unsupported sandbox type: ${sandboxType}`);
}

/**
 * Spawn a command under the OS sandbox.
 * @param {string} sandboxType - 'bwrap' | 'sandbox-exec'
 * @param {string} cloneDir
 * @param {string[]} cmdArgs - [cmd, ...args]
 * @param {{cwd?:string, timeout?:number, env?:object}} spawnOpts
 * @returns {{exitCode:number, stdout:string, stderr:string}}
 */
export function spawnSandboxed(sandboxType, cloneDir, cmdArgs, spawnOpts = {}) {
  const workDir = spawnOpts.workDir ?? spawnOpts.cwd ?? cloneDir;
  const sandboxedArgs = buildSandboxedArgs(sandboxType, cloneDir, cmdArgs, { workDir });
  const [bin, ...args] = sandboxedArgs;
  const r = spawnSync(bin, args, {
    cwd: spawnOpts.cwd ?? cloneDir,
    timeout: spawnOpts.timeout ?? 120_000,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
    env: spawnOpts.env ?? process.env,
  });
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut: r.signal === 'SIGTERM' || r.status === null,
  };
}

/**
 * Spawn a command, using sandbox if available.
 * If no sandbox and not unsafeNoSandbox, throws with instructions.
 *
 * @param {string[]} cmdArgs - [cmd, ...args]
 * @param {string} cloneDir
 * @param {{sandboxType?:string|null, unsafeNoSandbox?:boolean, cwd?:string, timeout?:number}} opts
 * @returns {{exitCode:number, stdout:string, stderr:string}}
 */
export function spawnCandidateCmd(cmdArgs, cloneDir, opts = {}) {
  const { sandboxType, unsafeNoSandbox = false } = opts;

  if (!sandboxType) {
    if (!unsafeNoSandbox) {
      throw new Error(
        'No OS sandbox binary found (bwrap on Linux, sandbox-exec on macOS). ' +
        'Pass --unsafe-no-sandbox to run candidate commands without sandboxing ' +
        '(ONLY safe inside a disposable VM or container).'
      );
    }
    // Loud warning
    process.stderr.write(
      '\nWARNING: Running candidate commands WITHOUT sandbox protection.\n' +
      'This executes untrusted adversary-generated code with no network/write isolation.\n' +
      'ONLY safe inside a disposable VM or container.\n\n'
    );
    const [cmd, ...args] = cmdArgs;
    const r = spawnSync(cmd, args, {
      cwd: opts.cwd ?? cloneDir,
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

  return spawnSandboxed(sandboxType, cloneDir, cmdArgs, opts);
}
