// gate-fuzzing/lib/sandbox.mjs
// OS sandbox integration (§1.7, F6 — fix 1).
// Implements BOTH bwrap (Linux) and sandbox-exec (macOS) concretely.
// Refuses to run without sandbox unless --unsafe-no-sandbox is passed.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { escapeSeatbeltPath } from '@adlc/core';
import {
  SENSITIVE_HOME_DIRS,
  SENSITIVE_HOME_FILES,
  realpathSafe,
  isUnderOrEqual,
  isInsideClone,
  collectMaskedEnvFiles,
  resolveEnvMasks,
  collectWorktreeSiblingMasks,
  buildBwrapIsolationMounts,
} from './sandbox-masks.mjs';

export {
  escapeSeatbeltPath,
  SENSITIVE_HOME_DIRS,
  SENSITIVE_HOME_FILES,
  collectMaskedEnvFiles,
  collectWorktreeSiblingMasks,
};

const MAC_HOME_TOOLCHAINS = [
  '.nvm', '.volta', '.fnm', '.asdf', '.mise', '.local', '.cargo', '.rustup', '.npm', '.cache', '.bun', '.pnpm-store',
];

/**
 * Build the macOS SBPL sandbox profile.
 * Deny default, allow process execution, deny `$HOME` reads by default (re-allowing
 * only read-only toolchain dirs + `workDir`), deny host `.env*` files, sibling
 * `.worktrees`, and sensitive `$HOME` credentials, deny network, and confine writes to `cloneDir`.
 *
 * @param {string} cloneDir
 * @param {{homeDir?:string, workDir?:string, cwd?:string, repoRoot?:string, maxEnvScanDirs?:number, envMaskCache?:Map}} [opts]
 * @returns {string} SBPL profile string
 */
export function buildMacOSSbpl(cloneDir, opts = {}) {
  const escapedDir = escapeSeatbeltPath(cloneDir);
  const cloneLogical = resolve(cloneDir);
  const cloneReal = realpathSafe(cloneDir);
  const workDir = opts.workDir ?? cloneDir;
  const homeDir = opts.homeDir === undefined ? homedir() : opts.homeDir;
  const homeRules = [
    '(deny file-read* (subpath "/Users"))', '(allow file-read-metadata (subpath "/Users"))',
    '(deny file-read* (subpath "/private/tmp"))', '(allow file-read-metadata (subpath "/private/tmp"))',
  ];
  const seenDeny = new Set();
  const extraDenies = [];
  const pushDeny = (kind, p) => {
    const key = `${kind}:${p}`;
    if (seenDeny.has(key)) return;
    seenDeny.add(key);
    extraDenies.push(`(deny file-read* (${kind} "${escapeSeatbeltPath(p)}"))`);
  };
  if (homeDir) {
    const homeReal = realpathSafe(homeDir);
    const homeVariants = homeReal !== resolve(homeDir) ? [homeDir, homeReal] : [homeDir];
    for (const hv of homeVariants) {
      const eh = escapeSeatbeltPath(hv);
      homeRules.push(`(deny file-read* (subpath "${eh}"))`, `(allow file-read-metadata (subpath "${eh}"))`);
      for (const tc of MAC_HOME_TOOLCHAINS) {
        homeRules.push(`(allow file-read* (subpath "${escapeSeatbeltPath(join(hv, tc))}"))`);
      }
    }
    for (const rel of SENSITIVE_HOME_DIRS) {
      const logical = join(homeDir, rel);
      if (!isUnderOrEqual(cloneLogical, logical) && !isUnderOrEqual(cloneReal, logical)) pushDeny('subpath', logical);
      try {
        const real = realpathSync(logical);
        if (real !== resolve(logical) && !isInsideClone(cloneLogical, cloneReal, real)) pushDeny('subpath', real);
      } catch { /* absent on host */ }
    }
    for (const rel of SENSITIVE_HOME_FILES) {
      const logical = join(homeDir, rel);
      if (!isUnderOrEqual(cloneLogical, logical) && !isUnderOrEqual(cloneReal, logical)) pushDeny('literal', logical);
      try {
        const real = realpathSync(logical);
        if (real !== resolve(logical) && !isInsideClone(cloneLogical, cloneReal, real)) pushDeny('literal', real);
      } catch { /* absent on host */ }
    }
  }
  if (workDir !== cloneDir) {
    homeRules.push(`(allow file-read* (subpath "${escapeSeatbeltPath(workDir)}"))`);
    const workReal = realpathSafe(workDir);
    if (workReal !== workDir) homeRules.push(`(allow file-read* (subpath "${escapeSeatbeltPath(workReal)}"))`);
  }
  const hostFallback = opts.repoRoot === undefined && opts.cwd === undefined && workDir === cloneDir ? process.cwd() : null;
  const roots = [workDir, opts.cwd, opts.repoRoot, hostFallback];
  const wtSiblings = collectWorktreeSiblingMasks(roots, cloneDir, workDir);
  for (const wt of wtSiblings) {
    pushDeny('subpath', wt);
  }
  const envFiles = resolveEnvMasks(roots, cloneDir, {
    flatRoots: homeDir ? [homeDir] : [],
    skipDirs: wtSiblings,
    maxDirs: opts.maxEnvScanDirs,
    envMaskCache: opts.envMaskCache,
  });
  for (const envFile of envFiles) {
    pushDeny('literal', envFile);
  }
  const cloneAllows = [
    `(allow file-read* (subpath "${escapedDir}"))`,
    `(allow file-write* (subpath "${escapedDir}"))`,
  ];
  if (cloneReal !== cloneDir) {
    const escapedReal = escapeSeatbeltPath(cloneReal);
    if (escapedReal !== escapedDir) {
      cloneAllows.push(`(allow file-read* (subpath "${escapedReal}"))`, `(allow file-write* (subpath "${escapedReal}"))`);
    }
  }
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow file-read*)',
    '(deny network*)',
    ...homeRules,
    '(deny file-read* (regex #"(^|/)\\.env(\\..+)?$"))',
    ...extraDenies,
    ...cloneAllows,
    '(allow file-write-data (path "/dev/null"))',
  ].join('');
}

export const seatbeltWrap = buildMacOSSbpl;

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

const CANDIDATE_SECRET_PATTERNS = [
  /^ADLC_/i,
  /API_KEY$/i,
  /_KEY$/i,
  /_SECRET$/i,
  /SECRET$/i,
  /_TOKEN$/i,
  /TOKEN$/i,
  /PASSWORD/i,
  /^AWS_/i,
  /^GOOGLE_/i,
  /^GCP_/i,
  /^AZURE_/i,
  /^GH_/i,
  /^GITHUB_TOKEN$/i,
  /CREDENTIAL/i,
  /^NPM_TOKEN$/i,
];

function isSensitiveCandidateVar(name) {
  return CANDIDATE_SECRET_PATTERNS.some((re) => re.test(name));
}

/**
 * Build a scrubbed copy of `baseEnv` for adversary-generated setup/witness
 * commands (#648): strips ADLC_* trust-root variables (including
 * ADLC_MANIFEST_KEY) and provider/cloud credentials (*_API_KEY, *_TOKEN, etc.)
 * while preserving benign runtime variables (PATH, HOME, LANG, TMPDIR, etc.).
 *
 * @param {Record<string, string | undefined>} [baseEnv]
 * @returns {Record<string, string>}
 */
export function sanitizeCandidateEnv(baseEnv = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) continue;
    if (isSensitiveCandidateVar(k)) continue;
    out[k] = v;
  }
  return out;
}

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
 * Build sandboxed argv for running a command inside the sandbox.
 *
 * Fix 1 implementation:
 * - bwrap: --unshare-all --ro-bind / / (+ masks over host .env* and $HOME creds)
 *          --bind <cloneDir> <cloneDir>
 *          --dev /dev --proc /proc --die-with-parent --new-session
 *          --chdir <workDir> -- <cmd> <args>
 *          (no --share-net: network unshared/denied)
 * - sandbox-exec: -p '<SBPL>' <cmd> <args>
 *
 * @param {'bwrap'|'sandbox-exec'} sandboxType
 * @param {string} cloneDir - the ONLY writable subpath
 * @param {string[]} cmdArgs - [cmd, ...args]
 * @param {{workDir?:string, cwd?:string, repoRoot?:string, homeDir?:string}} [opts]
 * @returns {string[]} Full argv including sandbox binary and args
 */
function assertSafeCmdArgs(cmdArgs) {
  if (
    !Array.isArray(cmdArgs) ||
    cmdArgs.length === 0 ||
    typeof cmdArgs[0] !== 'string' ||
    cmdArgs[0].length === 0 ||
    cmdArgs[0].startsWith('-') ||
    cmdArgs[0].includes('\0')
  ) {
    throw new Error('cmdArgs[0] must be a non-empty executable name or path without NUL bytes or a leading "-"');
  }
}

export function buildSandboxedArgs(sandboxType, cloneDir, cmdArgs, opts = {}) {
  assertSafeCmdArgs(cmdArgs);
  const workDir = opts.workDir ?? cloneDir;
  const homeDir = opts.homeDir === undefined ? homedir() : opts.homeDir;
  if (sandboxType === 'bwrap') {
    const isolationMounts = buildBwrapIsolationMounts({
      cloneDir,
      workDir,
      cwd: opts.cwd,
      repoRoot: opts.repoRoot,
      homeDir,
      maxDirs: opts.maxEnvScanDirs,
      envMaskCache: opts.envMaskCache,
    });
    const cloneReal = realpathSafe(cloneDir);
    const cloneBinds = ['--bind', cloneDir, cloneDir];
    if (cloneReal !== cloneDir && cloneReal !== resolve(cloneDir)) {
      cloneBinds.push('--bind', cloneReal, cloneReal);
    }
    return [
      'bwrap',
      '--unshare-all',
      '--ro-bind', '/', '/',
      ...isolationMounts,
      ...cloneBinds,
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
    const sbpl = buildMacOSSbpl(cloneDir, {
      homeDir,
      workDir,
      cwd: opts.cwd,
      repoRoot: opts.repoRoot,
      maxEnvScanDirs: opts.maxEnvScanDirs,
      envMaskCache: opts.envMaskCache,
    });
    return [
      'sandbox-exec',
      '-p', sbpl,
      '--',
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
 * @param {{cwd?:string, workDir?:string, repoRoot?:string, homeDir?:string, timeout?:number, env?:object, spawn?:Function}} spawnOpts
 * @returns {{exitCode:number, stdout:string, stderr:string, timedOut:boolean}}
 */
export function spawnSandboxed(sandboxType, cloneDir, cmdArgs, spawnOpts = {}) {
  const workDir = spawnOpts.workDir ?? spawnOpts.cwd ?? cloneDir;
  const sandboxedArgs = buildSandboxedArgs(sandboxType, cloneDir, cmdArgs, {
    workDir,
    cwd: spawnOpts.cwd,
    repoRoot: spawnOpts.repoRoot,
    homeDir: spawnOpts.homeDir,
    maxEnvScanDirs: spawnOpts.maxEnvScanDirs,
    envMaskCache: spawnOpts.envMaskCache,
  });
  const [bin, ...args] = sandboxedArgs;
  const runSpawn = spawnOpts.spawn ?? spawnSync;
  const r = runSpawn(bin, args, {
    cwd: spawnOpts.cwd ?? cloneDir,
    timeout: spawnOpts.timeout ?? 120_000,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
    env: spawnOpts.env ?? sanitizeCandidateEnv(),
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
 * @param {{sandboxType?:string|null, unsafeNoSandbox?:boolean, cwd?:string, repoRoot?:string, homeDir?:string, timeout?:number, env?:object, spawn?:Function}} opts
 * @returns {{exitCode:number, stdout:string, stderr:string, timedOut:boolean}}
 */
export function spawnCandidateCmd(cmdArgs, cloneDir, opts = {}) {
  assertSafeCmdArgs(cmdArgs);
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
    const runSpawn = opts.spawn ?? spawnSync;
    const r = runSpawn(cmd, args, {
      cwd: opts.cwd ?? cloneDir,
      timeout: opts.timeout ?? 120_000,
      encoding: 'utf8',
      stdio: 'pipe',
      shell: false,
      env: opts.env ?? sanitizeCandidateEnv(),
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
