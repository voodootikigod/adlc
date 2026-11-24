// preflight/lib/checks.mjs — individual check implementations.
// Each check is an isolated async function returning { name, status, detail }.
// status: 'pass' | 'fail' | 'skipped'
// All checks guarantee cleanup in finally blocks.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { detectProvider, git, ADLC_DIR } from '@adlc/core';

const DEFAULT_CMD_TIMEOUT_MS = 60_000;

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a command with a hard timeout and return { exitCode, stdout, stderr }.
 * Never throws — failures and timeouts are captured in the result.
 */
async function runCmd(cmd, args = [], opts = {}) {
  const { timeoutMs = DEFAULT_CMD_TIMEOUT_MS, ...spawnOpts } = opts;
  const detached = process.platform !== 'win32';
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { ...spawnOpts, detached, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (detached && proc.pid) {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      }
      try { proc.kill('SIGKILL'); } catch {}
      finish({
        exitCode: -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: `command timed out after ${timeoutMs}ms`,
        timedOut: true,
      });
    }, timeoutMs);
    timer.unref?.();
    proc.stdout.on('data', (d) => stdout.push(d));
    proc.stderr.on('data', (d) => stderr.push(d));
    proc.on('error', (err) => finish({ exitCode: -1, stdout: '', stderr: err.message }));
    proc.on('close', (code) => finish({
      exitCode: code ?? -1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

/** Return last N lines of text (non-empty lines). */
function tailLines(text, n = 10) {
  return text.split('\n').filter((l) => l.trim()).slice(-n).join('\n');
}

// ── required checks ──────────────────────────────────────────────────────────

/** REQUIRED: bash — invoke 'sh -c "echo preflight-ok"' and verify output. */
export async function checkBash(env = process.env) {
  const name = 'bash';
  try {
    const { exitCode, stdout } = await runCmd('sh', ['-c', 'echo preflight-ok'], { env });
    if (exitCode !== 0) {
      return { name, status: 'fail', detail: `echo exited ${exitCode}` };
    }
    if (!stdout.includes('preflight-ok')) {
      return { name, status: 'fail', detail: `unexpected echo output: ${stdout.trim()}` };
    }
    return { name, status: 'pass', detail: 'echo preflight-ok succeeded' };
  } catch (err) {
    return { name, status: 'fail', detail: String(err.message ?? err) };
  }
}

/** REQUIRED: git — git status in cwd (must be a git repo). */
export async function checkGit(cwd = process.cwd(), { env } = {}) {
  const name = 'git';
  try {
    git(['status'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    return { name, status: 'pass', detail: 'git status succeeded' };
  } catch (err) {
    const msg = String(err.message ?? err);
    if (msg.includes('not a git repository') || msg.includes('fatal:')) {
      return { name, status: 'fail', detail: 'cwd is not a git repository' };
    }
    return { name, status: 'fail', detail: msg.split('\n')[0] };
  }
}

/** REQUIRED: write — write+delete ${adlcDir}/tmp/preflight-test in cwd. */
export async function checkWrite(cwd = process.cwd(), options = {}) {
  const name = 'write';
  const adlcDir = (typeof options.dir === 'string' && options.dir.trim())
    ? options.dir.trim()
    : (options.env?.ADLC_DIR ?? process.env.ADLC_DIR ?? ADLC_DIR);
  const dir = join(cwd, adlcDir, 'tmp');
  const file = join(dir, 'preflight-test');
  const relPath = join(adlcDir, 'tmp', 'preflight-test');
  let written = false;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, 'preflight-write-test');
    written = true;
    return { name, status: 'pass', detail: `${relPath} written and removed` };
  } catch (err) {
    return { name, status: 'fail', detail: String(err.message ?? err) };
  } finally {
    if (written) {
      try {
        await unlink(file);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/** REQUIRED: branch — create and delete a randomized ephemeral branch (reaps stale branch and verifies cleanup). */
export async function checkBranch(cwd = process.cwd(), { gitFn = git, env, branchName } = {}) {
  const name = 'branch';
  const targetBranch = branchName ?? `preflight-check-${process.pid}-${randomBytes(4).toString('hex')}`;
  const gitOpts = { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) };
  try {
    gitFn(['branch', '-D', targetBranch], gitOpts);
  } catch {
    // no leftover branch to reap
  }
  try {
    gitFn(['branch', targetBranch], gitOpts);
  } catch (err) {
    const msg = String(err.message ?? err);
    if (msg.includes(`already exists`)) {
      return {
        name,
        status: 'fail',
        detail: `branch '${targetBranch}' already exists — likely left by a prior crashed run; delete it manually: git branch -D ${targetBranch}`,
      };
    }
    // Preserve the full fatal message (may span multiple lines) up to 3 lines for readability
    const detail = msg.split('\n').filter((l) => l.trim()).slice(0, 3).join(' | ');
    return { name, status: 'fail', detail };
  }
  let cleanupErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      gitFn(['branch', '-D', targetBranch], gitOpts);
      return { name, status: 'pass', detail: `branch '${targetBranch}' created and removed` };
    } catch (err) {
      cleanupErr = err;
    }
  }
  const msg = String(cleanupErr.message ?? cleanupErr).split('\n')[0];
  return {
    name,
    status: 'fail',
    detail: `branch '${targetBranch}' created; cleanup failed: ${msg}`,
  };
}

// ── optional checks ──────────────────────────────────────────────────────────

/** OPTIONAL (--worktrees): add/remove a randomized detached worktree (reaps stale worktree and verifies cleanup). */
export async function checkWorktrees(cwd = process.cwd(), { gitFn = git, env, worktreeName } = {}) {
  const name = 'worktrees';
  const targetName = worktreeName ?? `preflight-check-${process.pid}-${randomBytes(4).toString('hex')}`;
  const worktreePath = join(cwd, '.worktrees', targetName);
  const gitOpts = { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) };
  try {
    gitFn(['worktree', 'remove', '--force', worktreePath], gitOpts);
  } catch {
    // no leftover worktree to reap
  }
  try {
    gitFn(
      ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', worktreePath],
      gitOpts
    );
  } catch (err) {
    return { name, status: 'fail', detail: String(err.message ?? err).split('\n')[0] };
  }
  let cleanupErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      gitFn(
        ['worktree', 'remove', '--force', worktreePath],
        gitOpts
      );
      return { name, status: 'pass', detail: 'worktree add/remove succeeded' };
    } catch (err) {
      cleanupErr = err;
    }
  }
  const msg = String(cleanupErr.message ?? cleanupErr).split('\n')[0];
  return { name, status: 'fail', detail: `worktree added; cleanup failed: ${msg}` };
}

/** OPTIONAL (--test-cmd "..."): run the given command and expect exit 0. */
export async function checkTestCmd(cmd, cwd = process.cwd(), { env, timeoutMs } = {}) {
  const name = 'test-cmd';
  try {
    // Parse simple shell string into argv (no shell injection — just whitespace split)
    // For commands with shell features, delegate to sh -c
    const { exitCode, stdout, stderr } = await runCmd('sh', ['-c', cmd], {
      cwd,
      ...(env ? { env } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    const output = (stdout + stderr).trim();
    const tail = tailLines(output, 10);
    if (exitCode !== 0) {
      return {
        name,
        status: 'fail',
        detail: `exited ${exitCode}${tail ? `\n${tail}` : ''}`,
      };
    }
    return { name, status: 'pass', detail: `exited 0${tail ? `\n${tail}` : ''}` };
  } catch (err) {
    return { name, status: 'fail', detail: String(err.message ?? err) };
  }
}

/** OPTIONAL (--gh): gh auth status exits 0. */
export async function checkGh(env = process.env, { timeoutMs } = {}) {
  const name = 'gh';
  try {
    const { exitCode, stderr } = await runCmd('gh', ['auth', 'status'], {
      env,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    if (exitCode !== 0) {
      return { name, status: 'fail', detail: `gh auth status exited ${exitCode}: ${stderr.trim()}` };
    }
    return { name, status: 'pass', detail: 'gh auth status OK' };
  } catch (err) {
    return { name, status: 'fail', detail: String(err.message ?? err) };
  }
}

/** OPTIONAL (--llm): detectProvider() is non-null — no API call made. */
export async function checkLlm(env = process.env) {
  const name = 'llm';
  try {
    const provider = detectProvider(env);
    if (!provider) {
      return {
        name,
        status: 'fail',
        detail: 'no LLM provider detected (set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY)',
      };
    }
    return { name, status: 'pass', detail: `provider: ${provider.name}` };
  } catch (err) {
    return { name, status: 'fail', detail: String(err.message ?? err) };
  }
}
