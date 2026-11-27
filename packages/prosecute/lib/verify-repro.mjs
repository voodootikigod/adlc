import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  buildSandboxedArgs,
  detectSandbox,
  git,
  repoRoot,
  resolveSandboxBinary,
  tokenizeCommand,
} from '@adlc/core';

const FORBIDDEN_COMMANDS = new Set(['sh', 'bash', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh', 'eval']);
const SAFE_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT'];

function buildMinimalReproEnv(baseEnv, isolatedHome) {
  const env = {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    TMPDIR: isolatedHome,
    TMP: isolatedHome,
    TEMP: isolatedHome,
    NODE_ENV: 'test',
    CI: '1',
    NO_COLOR: '1',
  };
  for (const key of SAFE_ENV_KEYS) {
    if (typeof baseEnv?.[key] === 'string' && baseEnv[key].length > 0) {
      env[key] = baseEnv[key];
    }
  }
  return env;
}

function resolveExecutable(cmd, workDir, pathEnv = process.env.PATH ?? '') {
  if (typeof cmd !== 'string' || cmd.length === 0 || cmd.startsWith('-') || cmd.includes('\0')) {
    return null;
  }
  const isExecutableFile = (candidate) => {
    try {
      const st = statSync(candidate);
      if (!st.isFile()) return false;
      if (process.platform !== 'win32') {
        accessSync(candidate, fsConstants.X_OK);
      }
      return true;
    } catch {
      return false;
    }
  };

  if (cmd.includes('/') || cmd.includes('\\')) {
    const target = isAbsolute(cmd) ? cmd : resolve(workDir, cmd);
    return isExecutableFile(target) ? target : null;
  }

  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.com'] : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `${cmd}${ext}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function linkWorkspaceSafeNodeModules(root, tempWorkspace, { dereferenceExternal = false } = {}) {
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
          const linkTarget = join(tempWorkspace, relToRoot);
          const targetIsDir = statSync(realTarget).isDirectory();
          const linkType = targetIsDir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file';
          symlinkSync(linkTarget, dstPath, linkType);
        } else if (dereferenceExternal) {
          cpSync(realTarget, dstPath, { recursive: true, dereference: true });
        } else {
          const targetIsDir = statSync(realTarget).isDirectory();
          const linkType = targetIsDir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file';
          symlinkSync(realTarget, dstPath, linkType);
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
  if (typeof cmd !== 'string' || cmd.trim() === '') {
    return {
      reproduced: false,
      exitCode: 1,
      operationalError: true,
      status: null,
      error: 'Empty command provided',
      stdout: '',
      stderr: 'error: empty command provided',
    };
  }

  let argv;
  try {
    argv = tokenizeCommand(cmd);
  } catch (err) {
    return {
      reproduced: false,
      exitCode: 1,
      operationalError: true,
      status: null,
      error: err.message,
      stdout: '',
      stderr: `error: command tokenize failed: ${err.message}`,
    };
  }

  if (!argv || argv.length === 0) {
    return {
      reproduced: false,
      exitCode: 1,
      operationalError: true,
      status: null,
      error: 'Empty command provided after tokenization',
      stdout: '',
      stderr: 'error: empty command provided',
    };
  }

  const binaryBase = argv[0].toLowerCase().split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat|com)$/i, '');
  if (FORBIDDEN_COMMANDS.has(binaryBase)) {
    return {
      reproduced: false,
      exitCode: 1,
      operationalError: true,
      status: null,
      error: `Shell wrapper/eval is forbidden: ${argv[0]}`,
      stdout: '',
      stderr: `error: shell wrapper "${argv[0]}" is forbidden for repro verification`,
    };
  }

  const sandboxType = explicitSandboxType !== undefined ? explicitSandboxType : detectSandbox();
  if (!sandboxType && !unsafeNoSandbox) {
    const msg =
      'No OS sandbox available (bwrap on Linux, sandbox-exec on macOS). ' +
      'Pass --unsafe-no-sandbox only inside an isolated VM or container.';
    return {
      reproduced: false,
      exitCode: 1,
      operationalError: true,
      status: null,
      error: msg,
      stdout: '',
      stderr: `error: ${msg}`,
    };
  }

  let launcherPath = null;
  if (sandboxType) {
    launcherPath = resolveSandboxBinary(sandboxType);
    if (!launcherPath) {
      const msg = `No trusted root-owned sandbox binary found for ${sandboxType}`;
      return {
        reproduced: false,
        exitCode: 1,
        operationalError: true,
        status: null,
        error: msg,
        stdout: '',
        stderr: `error: ${msg}`,
      };
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
    mkdirSync(isolatedHome, { recursive: true });
    const childEnv = buildMinimalReproEnv(process.env, isolatedHome);

    if (!resolveExecutable(argv[0], tempWorkspace, childEnv.PATH)) {
      const msg = `Executable not found: ${argv[0]}`;
      return {
        reproduced: false,
        exitCode: 1,
        operationalError: true,
        status: null,
        error: msg,
        stdout: '',
        stderr: `error: ${msg}`,
      };
    }

    let spawnBin = argv[0];
    let spawnArgs = argv.slice(1);
    if (sandboxType) {
      try {
        [spawnBin, ...spawnArgs] = buildSandboxedArgs(sandboxType, tempWorkspace, argv, {
          workDir: tempWorkspace,
          cwd: tempWorkspace,
          repoRoot: root,
          launcherPath,
        });
      } catch (err) {
        return {
          reproduced: false,
          exitCode: 1,
          operationalError: true,
          status: null,
          error: err.message,
          stdout: '',
          stderr: `error: ${err.message}`,
        };
      }
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
      return {
        reproduced: false,
        exitCode: 1,
        operationalError: true,
        status: res.status,
        error: msg,
        stdout: res.stdout || '',
        stderr: res.stderr || `error: ${msg}`,
      };
    }

    if (res.status === 126 || res.status === 127) {
      return {
        reproduced: false,
        exitCode: 1,
        operationalError: true,
        status: res.status,
        error: `Binary execution failed with status ${res.status}`,
        stdout: res.stdout || '',
        stderr: res.stderr || `error: command exited with status ${res.status}`,
      };
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
