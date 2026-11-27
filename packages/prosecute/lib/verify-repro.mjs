import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
  buildSandboxedArgs,
  detectSandbox,
  git,
  repoRoot,
  resolveSandboxBinary,
  sanitizeCandidateEnv,
  tokenizeCommand,
} from '@adlc/core';

const FORBIDDEN_COMMANDS = new Set(['sh', 'bash', 'zsh', 'eval']);

function buildMinimalReproEnv(baseEnv, isolatedHome) {
  const env = {
    ...sanitizeCandidateEnv(baseEnv),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome,
    TMPDIR: isolatedHome,
    TMP: isolatedHome,
    TEMP: isolatedHome,
  };
  delete env.ADLC_MANIFEST_KEY;
  return env;
}

function opFailure(msg, status = null) {
  return {
    reproduced: false,
    exitCode: 1,
    operationalError: true,
    status,
    error: msg,
    stdout: '',
    stderr: `error: ${msg}`,
  };
}

function linkWorkspaceSafeNodeModules(root, tempWorkspace, { dereferenceExternal }) {
  const rootNm = join(root, 'node_modules');
  const destNm = join(tempWorkspace, 'node_modules');
  if (!existsSync(rootNm) || existsSync(destNm)) return;

  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }

  const linkEntries = (srcDir, dstDir) => {
    mkdirSync(dstDir, { recursive: true });
    for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = join(srcDir, ent.name);
      const dstPath = join(dstDir, ent.name);
      if ((ent.name.startsWith('@') || ent.name === '.bin') && ent.isDirectory() && !ent.isSymbolicLink()) {
        linkEntries(srcPath, dstPath);
        continue;
      }
      try {
        const realTarget = realpathSync(srcPath);
        const relToRoot = relative(realRoot, realTarget);
        const pointsInsideRepo =
          relToRoot !== '' &&
          !relToRoot.startsWith('..') &&
          !relToRoot.startsWith(`.${sep}`) &&
          relToRoot.split(sep)[0] !== 'node_modules';
        if (pointsInsideRepo) {
          symlinkSync(join(tempWorkspace, relToRoot), dstPath);
        } else if (dereferenceExternal) {
          cpSync(realTarget, dstPath, { recursive: true, dereference: true });
        } else {
          symlinkSync(realTarget, dstPath);
        }
      } catch {
        // ignore broken or unreadable node_modules entries
      }
    }
  };

  try {
    linkEntries(rootNm, destNm);
  } catch {
    // ignore optional node_modules linking failure
  }
}

/**
 * Verify a candidate reproduction command inside an OS-sandboxed disposable workspace
 * (`bwrap --unshare-all --ro-bind / /` on Linux, `sandbox-exec` seatbelt on macOS).
 * Fails closed when no OS sandbox is available unless `unsafeNoSandbox: true` is explicitly passed.
 */
export function verifyRepro({
  cmd,
  expectFail = false,
  timeoutMs = 30000,
  root: explicitRoot,
  sandboxType: explicitSandboxType,
  unsafeNoSandbox = false,
}) {
  if (typeof cmd !== 'string') {
    return opFailure('Empty command provided');
  }

  let argv;
  try {
    argv = tokenizeCommand(cmd);
  } catch (err) {
    return opFailure(err.message);
  }

  if (argv.length === 0) {
    return opFailure('Empty command provided');
  }

  const binaryBase = argv[0].toLowerCase().split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat|com)$/i, '');
  if (argv[0].startsWith('-') || FORBIDDEN_COMMANDS.has(binaryBase)) {
    return opFailure(`Shell wrapper/eval or leading-dash executable is forbidden: ${argv[0]}`);
  }

  const sandboxType = explicitSandboxType !== undefined ? explicitSandboxType : detectSandbox();
  if (!sandboxType && !unsafeNoSandbox) {
    return opFailure(
      'No OS sandbox available (bwrap on Linux, sandbox-exec on macOS). ' +
      'Pass --unsafe-no-sandbox only inside an isolated VM or container.',
    );
  }

  let launcherPath = null;
  if (sandboxType) {
    launcherPath = resolveSandboxBinary(sandboxType);
    if (!launcherPath) {
      return opFailure(`No trusted root-owned sandbox binary found for ${sandboxType}`);
    }
  }

  let root;
  try {
    root = explicitRoot ? resolve(explicitRoot) : repoRoot();
  } catch {
    root = resolve(process.cwd());
  }

  const tempWorkspace = mkdtempSync(join(tmpdir(), 'adlc-prosecute-repro-'));

  try {
    let filesToCopy = [];
    try {
      const trackedAndUntracked = git(
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: root },
      );
      filesToCopy = trackedAndUntracked.split('\0').filter(Boolean);
    } catch {
      // Not a git repo: fall back to filtered directory copy below
    }

    const isSecretOrIgnored = (rel) => {
      const parts = rel.split(/[\\/]/);
      if (parts[0] === '.git' || parts[0] === '.worktrees' || parts[0] === 'node_modules') {
        return true;
      }
      const base = parts[parts.length - 1];
      return base.startsWith('.env');
    };

    if (filesToCopy.length > 0) {
      for (const rel of filesToCopy) {
        if (isSecretOrIgnored(rel)) continue;
        const src = join(root, rel);
        const dest = join(tempWorkspace, rel);
        try {
          cpSync(src, dest, { recursive: true, dereference: false });
        } catch {
          // ignore vanished/unreadable files
        }
      }
    } else {
      try {
        cpSync(root, tempWorkspace, {
          recursive: true,
          dereference: false,
          filter: (src) => {
            const rel = src.slice(root.length).replace(/^[\\/]/, '');
            if (!rel) return true;
            return !isSecretOrIgnored(rel);
          },
        });
      } catch {
        // ignore copy errors
      }
    }

    linkWorkspaceSafeNodeModules(root, tempWorkspace, { dereferenceExternal: !sandboxType });

    const isolatedHome = join(tempWorkspace, '.adlc-repro-home');
    mkdirSync(isolatedHome);
    const childEnv = buildMinimalReproEnv(process.env, isolatedHome);

    let spawnBin = argv[0];
    let spawnArgs = argv.slice(1);
    if (sandboxType) {
      [spawnBin, ...spawnArgs] = buildSandboxedArgs(sandboxType, tempWorkspace, argv, {
        workDir: tempWorkspace,
        cwd: tempWorkspace,
        repoRoot: root,
        launcherPath,
      });
    }

    const res = spawnSync(spawnBin, spawnArgs, {
      shell: false,
      cwd: tempWorkspace,
      env: childEnv,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    });

    if (res.error) {
      const isTimeout = res.error.code === 'ETIMEDOUT' || res.signal === 'SIGTERM';
      const msg = isTimeout ? `Command timed out after ${timeoutMs}ms` : res.error.message;
      return opFailure(msg, res.status);
    }

    if (/^bwrap: execvp /m.test(res.stderr)) {
      return opFailure(`Binary execution failed with status ${res.status}`, res.status);
    }

    const status = res.status;
    const exitedZero = status === 0 && !res.signal;
    const reproduced = expectFail ? !exitedZero : exitedZero;
    const exitCode = reproduced ? 0 : 2;

    return {
      reproduced,
      exitCode,
      operationalError: false,
      status,
      signal: res.signal ?? null,
      sandbox: sandboxType ?? 'none',
      stdout: res.stdout || '',
      stderr: res.stderr || '',
    };
  } finally {
    try {
      rmSync(tempWorkspace, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
