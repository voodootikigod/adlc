// preflight unit tests — individual check functions and render utilities.
// node:test, offline, no API keys, temp dirs cleaned up.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmp, gitRepo } from '@adlc/core/test-kit';

import { computeVerdict, renderTable } from '../lib/render.mjs';
import {
  checkBash, checkGit, checkWrite, checkBranch,
  checkWorktrees, checkTestCmd, checkLlm,
} from '../lib/checks.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

function initRepo(t) {
  const { dir, git } = gitRepo(t, { prefix: 'preflight-unit-' });
  writeFileSync(join(dir, 'README.md'), 'test');
  git('add', '.');
  git('commit', '-m', 'init');
  return dir;
}

// ── checkBash ─────────────────────────────────────────────────────────────────

describe('checkBash', () => {
  it('passes when echo works', async () => {
    const result = await checkBash();
    assert.equal(result.name, 'bash');
    assert.equal(result.status, 'pass');
  });
});

// ── checkGit ──────────────────────────────────────────────────────────────────

describe('checkGit', () => {
  let repoDir;
  let nonRepoDir;

  beforeEach((t) => {
    repoDir = initRepo(t);
    nonRepoDir = tmp(t, 'preflight-unit-');
  });

  it('passes in a git repo', async () => {
    const result = await checkGit(repoDir);
    assert.equal(result.name, 'git');
    assert.equal(result.status, 'pass');
  });

  it('fails in a non-git directory', async () => {
    const result = await checkGit(nonRepoDir);
    assert.equal(result.name, 'git');
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /not a git repo/i);
  });
});

// ── checkWrite ────────────────────────────────────────────────────────────────

describe('checkWrite', () => {
  let dir;

  beforeEach((t) => { dir = tmp(t, 'preflight-unit-'); });

  it('passes and leaves no residue', async () => {
    const result = await checkWrite(dir);
    assert.equal(result.status, 'pass');
    const tmpFile = join(dir, '.adlc', 'tmp', 'preflight-test');
    assert.equal(existsSync(tmpFile), false, 'preflight-test file should be cleaned up');
  });

  it('supports custom options.dir', async () => {
    const customDir = '.sdlc/.adlc';
    const result = await checkWrite(dir, { dir: customDir });
    assert.equal(result.status, 'pass');
    assert.match(result.detail, /\.sdlc\/\.adlc\/tmp\/preflight-test written and removed/);
    const tmpFile = join(dir, customDir, 'tmp', 'preflight-test');
    assert.equal(existsSync(tmpFile), false, 'custom tmp file should be cleaned up');
  });

  it('supports options.env.ADLC_DIR', async () => {
    const envDir = '.env-adlc';
    const result = await checkWrite(dir, { env: { ADLC_DIR: envDir } });
    assert.equal(result.status, 'pass');
    assert.match(result.detail, /\.env-adlc\/tmp\/preflight-test written and removed/);
    const tmpFile = join(dir, envDir, 'tmp', 'preflight-test');
    assert.equal(existsSync(tmpFile), false, 'env tmp file should be cleaned up');
  });
});

// ── checkBranch ───────────────────────────────────────────────────────────────

describe('checkBranch', () => {
  let dir;

  beforeEach((t) => {
    dir = initRepo(t);
  });

  it('passes and cleans up the branch', async () => {
    const result = await checkBranch(dir);
    assert.equal(result.status, 'pass');
    const branchList = execFileSync('git', ['branch'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(
      branchList.includes('preflight-test-branch'),
      false,
      'preflight-test-branch must be absent after check'
    );
  });

  it('fails gracefully in a non-repo dir', async (t) => {
    const nonRepo = tmp(t, 'preflight-unit-');
    const result = await checkBranch(nonRepo);
    assert.equal(result.status, 'fail');
  });

  it('reaps a pre-existing preflight-test-branch and passes (#496)', async () => {
    execFileSync('git', ['branch', 'preflight-test-branch'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await checkBranch(dir);
    assert.equal(result.status, 'pass');
    assert.equal(result.detail, "branch 'preflight-test-branch' created and removed");
    const branchList = execFileSync('git', ['branch'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(branchList.includes('preflight-test-branch'), false);
  });

  it('retries branch cleanup on transient error and passes when retry succeeds (#496)', async () => {
    let deleteCalls = 0;
    const gitFn = (args, opts) => {
      if (args[0] === 'branch' && args[1] === '-D') {
        deleteCalls += 1;
        // deleteCalls === 1 is pre-create reap; deleteCalls === 2 is first cleanup attempt
        if (deleteCalls === 2) throw new Error('packed-refs.lock held');
      }
      return execFileSync('git', args, opts);
    };
    const result = await checkBranch(dir, { gitFn });
    assert.equal(result.status, 'pass');
    assert.equal(deleteCalls, 3);
  });

  it('returns status: fail (never lies created and removed) when branch cleanup fails (#496)', async () => {
    let deleteCalls = 0;
    const gitFn = (args, opts) => {
      if (args[0] === 'branch' && args[1] === '-D') {
        deleteCalls += 1;
        if (deleteCalls >= 2) throw new Error('unable to lock packed-refs\nextra line');
      }
      return execFileSync('git', args, opts);
    };
    const result = await checkBranch(dir, { gitFn });
    assert.equal(result.status, 'fail');
    assert.equal(deleteCalls, 3);
    assert.match(result.detail, /branch 'preflight-test-branch' created; cleanup failed: unable to lock packed-refs/);
    assert.doesNotMatch(result.detail, /extra line/);
  });

  it('reports manual delete hint when branch already exists at create time', async () => {
    const gitFn = (args) => {
      if (args[0] === 'branch' && args[1] === '-D') throw new Error('reap blocked');
      throw new Error("fatal: a branch named 'preflight-test-branch' already exists");
    };
    const result = await checkBranch(dir, { gitFn });
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /already exists — likely left by a prior crashed run; delete it manually: git branch -D preflight-test-branch/);
  });
});

// ── checkWorktrees ────────────────────────────────────────────────────────────

describe('checkWorktrees', () => {
  let dir;

  beforeEach((t) => {
    dir = initRepo(t);
  });

  it('passes and leaves no residue', async () => {
    const result = await checkWorktrees(dir);
    assert.equal(result.status, 'pass');
    assert.equal(result.detail, 'worktree add/remove succeeded');
    const worktreePath = join(dir, '.worktrees', 'preflight-test');
    assert.equal(existsSync(worktreePath), false, 'worktree dir must be cleaned up');
  });

  it('reaps a pre-existing .worktrees/preflight-test and passes (#496)', async () => {
    const worktreePath = join(dir, '.worktrees', 'preflight-test');
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', worktreePath], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await checkWorktrees(dir);
    assert.equal(result.status, 'pass');
    assert.equal(existsSync(worktreePath), false);
  });

  it('retries worktree cleanup on transient error and fails if cleanup still fails (#496)', async () => {
    let removeCalls = 0;
    const gitFnRetry = (args, opts) => {
      assert.deepEqual(opts?.stdio, ['ignore', 'pipe', 'pipe']);
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removeCalls += 1;
        if (removeCalls === 2) throw new Error('transient lock');
      }
      return execFileSync('git', args, opts);
    };
    const passRes = await checkWorktrees(dir, { gitFn: gitFnRetry });
    assert.equal(passRes.status, 'pass');
    assert.equal(removeCalls, 3);

    let failCalls = 0;
    const gitFnFail = (args, opts) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        failCalls += 1;
        if (failCalls >= 2) throw new Error('worktree locked\nsecond line');
      }
      return execFileSync('git', args, opts);
    };
    const failRes = await checkWorktrees(dir, { gitFn: gitFnFail });
    assert.equal(failRes.status, 'fail');
    assert.equal(failCalls, 3);
    assert.match(failRes.detail, /worktree added; cleanup failed: worktree locked/);
    assert.doesNotMatch(failRes.detail, /second line/);
  });

  it('returns status: fail when worktree add fails', async () => {
    const gitFn = (args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') return '';
      throw new Error('add failed\nextra');
    };
    const res = await checkWorktrees(dir, { gitFn });
    assert.equal(res.status, 'fail');
    assert.equal(res.detail, 'add failed');
  });
});

// ── checkTestCmd ──────────────────────────────────────────────────────────────

describe('checkTestCmd', () => {
  let dir;

  beforeEach((t) => { dir = tmp(t, 'preflight-unit-'); });

  it('passes when command exits 0', async () => {
    const result = await checkTestCmd('exit 0', dir);
    assert.equal(result.status, 'pass');
  });

  it('fails when command exits non-zero', async () => {
    const result = await checkTestCmd('exit 1', dir);
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /exited 1/);
  });

  it('includes tail of output on failure', async () => {
    const result = await checkTestCmd('echo "error output" && exit 42', dir);
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /error output/);
  });
});

// ── checkLlm ─────────────────────────────────────────────────────────────────

describe('checkLlm', () => {
  it('passes when ANTHROPIC_API_KEY is set', async () => {
    const result = await checkLlm({ ANTHROPIC_API_KEY: 'sk-test-key' });
    assert.equal(result.status, 'pass');
    assert.match(result.detail, /anthropic/);
  });

  it('passes when OPENAI_API_KEY is set', async () => {
    const result = await checkLlm({ OPENAI_API_KEY: 'sk-test-key' });
    assert.equal(result.status, 'pass');
    assert.match(result.detail, /openai/);
  });

  it('fails when no provider key is set', async () => {
    const result = await checkLlm({});
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /no LLM provider/);
  });
});

// ── computeVerdict ────────────────────────────────────────────────────────────

describe('computeVerdict', () => {
  it('pass when all required checks pass', () => {
    const results = [
      { name: 'bash',   status: 'pass', required: true },
      { name: 'git',    status: 'pass', required: true },
      { name: 'write',  status: 'pass', required: true },
      { name: 'branch', status: 'pass', required: true },
    ];
    const { verdict, failedNames } = computeVerdict(results);
    assert.equal(verdict, 'pass');
    assert.deepEqual(failedNames, []);
  });

  it('fail when a required check fails', () => {
    const results = [
      { name: 'bash',   status: 'pass', required: true },
      { name: 'git',    status: 'fail', required: true },
      { name: 'write',  status: 'pass', required: true },
      { name: 'branch', status: 'pass', required: true },
    ];
    const { verdict, failedNames } = computeVerdict(results);
    assert.equal(verdict, 'fail');
    assert.deepEqual(failedNames, ['git']);
  });

  it('pass when all skipped (required: false)', () => {
    const results = [{ name: 'gh', status: 'skipped', required: false }];
    const { verdict } = computeVerdict(results);
    assert.equal(verdict, 'pass');
  });
});

// ── renderTable ───────────────────────────────────────────────────────────────

describe('renderTable', () => {
  it('produces lines containing check names and status labels', () => {
    const results = [
      { name: 'bash', status: 'pass', detail: 'ok' },
      { name: 'git',  status: 'fail', detail: 'not a repo' },
    ];
    const lines = renderTable(results);
    const joined = lines.join('\n');
    assert.match(joined, /bash/);
    assert.match(joined, /git/);
    assert.match(joined, /PASS/);
    assert.match(joined, /FAIL/);
  });
});

describe('checkBash shell invocation (#714)', () => {
  it('invokes sh -c rather than spawning echo directly, and fails when sh exits non-zero or outputs unexpected text', async (t) => {
    const binDir = tmp(t, 'preflight-fake-sh-');
    const shPath = join(binDir, 'sh');

    // 1. Fake sh that exits 42 -> checkBash fails with exit code 42
    writeFileSync(shPath, '#!/bin/bash\nexit 42\n', { mode: 0o755 });
    const failExit = await checkBash({ PATH: binDir });
    assert.equal(failExit.name, 'bash');
    assert.equal(failExit.status, 'fail');
    assert.match(failExit.detail, /exited 42/);

    // 2. Fake sh that exits 0 with wrong stdout -> checkBash fails with unexpected output
    writeFileSync(shPath, '#!/bin/bash\necho wrong-out\n', { mode: 0o755 });
    const failOut = await checkBash({ PATH: binDir });
    assert.equal(failOut.name, 'bash');
    assert.equal(failOut.status, 'fail');
    assert.match(failOut.detail, /unexpected echo output: wrong-out/);

    // 3. Fake sh that verifies "-c" and "echo preflight-ok" args -> checkBash passes
    writeFileSync(
      shPath,
      '#!/bin/bash\nif [ "$1" = "-c" ] && [ "$2" = "echo preflight-ok" ]; then echo preflight-ok; exit 0; else exit 9; fi\n',
      { mode: 0o755 }
    );
    const passRes = await checkBash({ PATH: binDir });
    assert.equal(passRes.name, 'bash');
    assert.equal(passRes.status, 'pass');
    assert.equal(passRes.detail, 'echo preflight-ok succeeded');
  });
});

describe('checkWorktrees disables repository hooks (#716)', () => {
  it('passes -c core.hooksPath=/dev/null so post-checkout hook does not execute', async (t) => {
    const { dir, git } = gitRepo(t, { prefix: 'preflight-wt-hook-' });
    writeFileSync(join(dir, 'README.md'), '# init\n');
    git('add', 'README.md');
    git('commit', '-m', 'init');
    const marker = join(dir, 'hook-fired.txt');
    const hooksDir = join(dir, 'custom-hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'post-checkout');
    writeFileSync(hookPath, `#!/bin/sh\necho fired > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    git('config', 'core.hooksPath', hooksDir);
    const res = await checkWorktrees(dir);
    assert.equal(res.status, 'pass', `expected pass, got: ${res.detail}`);
    assert.equal(existsSync(marker), false, 'post-checkout hook must not fire during checkWorktrees');
  });
});
