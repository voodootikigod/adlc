// preflight unit tests — individual check functions and render utilities.
// node:test, offline, no API keys, temp dirs cleaned up.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { computeVerdict, renderTable } from '../lib/render.mjs';
import {
  checkBash, checkGit, checkWrite, checkBranch,
  checkWorktrees, checkTestCmd, checkLlm,
} from '../lib/checks.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'preflight-unit-'));
}

function cleanTmp(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function initRepo(dir) {
  const g = (args) =>
    execFileSync('git', args, {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    });
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  g(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), 'test');
  g(['add', '.']);
  g(['commit', '-m', 'init']);
  return g;
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

  before(() => {
    repoDir = makeTmp();
    initRepo(repoDir);
    nonRepoDir = makeTmp();
  });

  after(() => {
    cleanTmp(repoDir);
    cleanTmp(nonRepoDir);
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

  before(() => { dir = makeTmp(); });
  after(() => cleanTmp(dir));

  it('passes and leaves no residue', async () => {
    const result = await checkWrite(dir);
    assert.equal(result.status, 'pass');
    const tmpFile = join(dir, '.aidlc', 'tmp', 'preflight-test');
    assert.equal(existsSync(tmpFile), false, 'preflight-test file should be cleaned up');
  });
});

// ── checkBranch ───────────────────────────────────────────────────────────────

describe('checkBranch', () => {
  let dir;

  before(() => {
    dir = makeTmp();
    initRepo(dir);
  });

  after(() => cleanTmp(dir));

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

  it('fails gracefully in a non-repo dir', async () => {
    const nonRepo = makeTmp();
    try {
      const result = await checkBranch(nonRepo);
      assert.equal(result.status, 'fail');
    } finally {
      cleanTmp(nonRepo);
    }
  });
});

// ── checkWorktrees ────────────────────────────────────────────────────────────

describe('checkWorktrees', () => {
  let dir;

  before(() => {
    dir = makeTmp();
    initRepo(dir);
  });

  after(() => cleanTmp(dir));

  it('passes and leaves no residue', async () => {
    const result = await checkWorktrees(dir);
    assert.equal(result.status, 'pass');
    const worktreePath = join(dir, '.worktrees', 'preflight-test');
    assert.equal(existsSync(worktreePath), false, 'worktree dir must be cleaned up');
  });
});

// ── checkTestCmd ──────────────────────────────────────────────────────────────

describe('checkTestCmd', () => {
  let dir;

  before(() => { dir = makeTmp(); });
  after(() => cleanTmp(dir));

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
