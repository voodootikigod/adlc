import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git, repoRoot, tokenizeCommand, sanitizeCandidateEnv } from '@adlc/core';

const FORBIDDEN_COMMANDS = new Set(['sh', 'bash', 'zsh', 'eval']);

/**
 * Verify a candidate reproduction command in a disposable sandboxed workspace.
 *
 * @param {object} options
 * @param {string} options.cmd - Command to execute
 * @param {boolean} [options.expectFail=false] - Whether a non-zero exit code represents reproduction
 * @param {number} [options.timeoutMs=30000] - Timeout in milliseconds
 * @param {string} [options.root] - Root directory to copy files from (default: git repoRoot())
 * @returns {{
 *   reproduced: boolean,
 *   exitCode: number,
 *   operationalError: boolean,
 *   status: number|null,
 *   error?: string,
 *   stdout: string,
 *   stderr: string
 * }}
 */
export function verifyRepro({
  cmd,
  expectFail = false,
  timeoutMs = 30000,
  root: explicitRoot,
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

  const binary = argv[0].toLowerCase();
  const binaryBase = binary.split(/[\\/]/).pop();
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

  let root;
  try {
    root = explicitRoot ? resolve(explicitRoot) : repoRoot();
  } catch (err) {
    root = resolve(process.cwd());
  }

  // Materialize disposable temp workspace
  const tempWorkspace = mkdtempSync(join(tmpdir(), 'adlc-prosecute-repro-'));

  try {
    // Gather files from git if in git repository, else copy directory
    let filesToCopy = [];
    try {
      const trackedAndUntracked = git(
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: root }
      );
      filesToCopy = trackedAndUntracked.split('\0').filter(Boolean);
    } catch {
      // If not a git repo or git fails, we do not copy git metadata
    }

    const isSecretOrIgnored = (rel) => {
      const parts = rel.split(/[\\/]/);
      if (parts[0] === '.git' || parts[0] === '.worktrees' || parts[0] === 'node_modules') {
        return true;
      }
      const base = parts[parts.length - 1];
      if (base.startsWith('.env')) {
        return true;
      }
      return false;
    };

    if (filesToCopy.length > 0) {
      for (const rel of filesToCopy) {
        if (isSecretOrIgnored(rel)) continue;
        const src = join(root, rel);
        const dest = join(tempWorkspace, rel);
        try {
          cpSync(src, dest, { recursive: true, dereference: false });
        } catch {
          // ignore unreadable/vanished files
        }
      }
    } else {
      // Fallback copy excluding .git, .worktrees, node_modules, .env*
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
        // ignore
      }
    }

    // Symlink read-only node_modules if present in root
    const rootNodeModules = join(root, 'node_modules');
    const destNodeModules = join(tempWorkspace, 'node_modules');
    if (existsSync(rootNodeModules) && !existsSync(destNodeModules)) {
      try {
        symlinkSync(rootNodeModules, destNodeModules, 'junction');
      } catch {
        // ignore symlink failures
      }
    }

    // Sanitize candidate environment
    const childEnv = sanitizeCandidateEnv(process.env);
    // Explicitly scrub ADLC_MANIFEST_KEY
    delete childEnv.ADLC_MANIFEST_KEY;

    const res = spawnSync(argv[0], argv.slice(1), {
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

    const status = res.status ?? 0;
    let reproduced = false;
    let exitCode = 2;

    if (expectFail) {
      if (status !== 0) {
        reproduced = true;
        exitCode = 0;
      } else {
        reproduced = false;
        exitCode = 2;
      }
    } else {
      if (status === 0) {
        reproduced = true;
        exitCode = 0;
      } else {
        reproduced = false;
        exitCode = 2;
      }
    }

    return {
      reproduced,
      exitCode,
      operationalError: false,
      status,
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
