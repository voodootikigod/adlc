// preflight integration tests — runChecks orchestration and CLI e2e.
// node:test, offline, no API keys, scratch git repos in mkdtemp.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmp, gitRepo } from '@adlc/core/test-kit';

import { runChecks } from '../lib/runner.mjs';
import { computeVerdict } from '../lib/render.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

function initRepo(t) {
  const { dir, git } = gitRepo(t, { prefix: 'preflight-int-' });
  writeFileSync(join(dir, 'README.md'), 'test');
  git('add', '.');
  git('commit', '-m', 'init');
  return dir;
}

const CLI_PATH = new URL('../bin/preflight.mjs', import.meta.url).pathname;

// ── runChecks — all-required-pass path ───────────────────────────────────────

describe('runChecks all-required-pass', () => {
  let dir;

  beforeEach((t) => {
    dir = initRepo(t);
  });

  it('all four required checks pass in a valid git repo', async () => {
    const results = await runChecks({ cwd: dir });
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));

    assert.ok(byName.bash,   'bash check present');
    assert.ok(byName.git,    'git check present');
    assert.ok(byName.write,  'write check present');
    assert.ok(byName.branch, 'branch check present');

    for (const r of results.filter((r) => r.required)) {
      assert.equal(r.status, 'pass', `${r.name} should pass`);
    }
  });

  it('branch absent after run (cleanup proof)', async () => {
    await runChecks({ cwd: dir });
    const branchList = execFileSync('git', ['branch'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(branchList.includes('preflight-test-branch'), false);
  });

  it('no residue: tmp file absent after run', async () => {
    await runChecks({ cwd: dir });
    const tmpFile = join(dir, '.adlc', 'tmp', 'preflight-test');
    assert.equal(existsSync(tmpFile), false);
  });
});

// ── runChecks — custom dir option ─────────────────────────────────────────────

describe('runChecks custom dir option', () => {
  let dir;

  beforeEach((t) => {
    dir = initRepo(t);
  });

  it('supports custom dir option without creating .adlc', async () => {
    const customDir = '.sdlc/.adlc';
    const results = await runChecks({ cwd: dir, dir: customDir });
    const writeResult = results.find((r) => r.name === 'write');
    assert.ok(writeResult);
    assert.equal(writeResult.status, 'pass');
    assert.match(writeResult.detail, /\.sdlc\/\.adlc\/tmp\/preflight-test written and removed/);
    assert.equal(existsSync(join(dir, customDir, 'tmp', 'preflight-test')), false);
    assert.equal(existsSync(join(dir, '.adlc')), false, '.adlc should not have been created');
  });
});

// ── runChecks — non-repo dir → git check fail ─────────────────────────────────

describe('runChecks non-repo dir', () => {
  let dir;

  beforeEach((t) => {
    dir = tmp(t, 'preflight-int-');
  });

  it('git check fails in non-repo', async () => {
    const results = await runChecks({ cwd: dir });
    const gitResult = results.find((r) => r.name === 'git');
    assert.ok(gitResult, 'git check must be present');
    assert.equal(gitResult.status, 'fail');
  });

  it('computeVerdict returns fail for non-repo', async () => {
    const results = await runChecks({ cwd: dir });
    const { verdict } = computeVerdict(results);
    assert.equal(verdict, 'fail');
  });
});

// ── CLI: failing --test-cmd exits 2 ──────────────────────────────────────────

describe('CLI --test-cmd exits 2 on failure', () => {
  let dir;

  beforeEach((t) => {
    dir = initRepo(t);
  });

  it('exits 2 when --test-cmd command fails', () => {
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, '--test-cmd', 'exit 1'],
      { cwd: dir, encoding: 'utf8' }
    );
    assert.equal(
      result.status,
      2,
      `expected exit 2, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });

  it('exits 0 when all checks pass with passing test-cmd', () => {
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, '--test-cmd', 'echo ok'],
      { cwd: dir, encoding: 'utf8' }
    );
    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });
});

// ── residue absent after both pass and fail paths ─────────────────────────────

describe('residue cleanup — pass and fail paths', () => {
  let passDir;
  let failDir;

  beforeEach((t) => {
    passDir = initRepo(t);
    failDir = tmp(t, 'preflight-int-'); // non-repo — git/branch checks fail
  });

  it('no residue after passing run', async () => {
    await runChecks({ cwd: passDir });

    const tmpFile = join(passDir, '.adlc', 'tmp', 'preflight-test');
    assert.equal(existsSync(tmpFile), false, 'tmp file absent after pass');

    const branchList = execFileSync('git', ['branch'], {
      cwd: passDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(branchList.includes('preflight-test-branch'), false, 'branch absent after pass');
  });

  it('no residue after failing run (non-repo)', async () => {
    await runChecks({ cwd: failDir });
    const tmpFile = join(failDir, '.adlc', 'tmp', 'preflight-test');
    assert.equal(existsSync(tmpFile), false, 'tmp file absent after failing run');
  });

  it('worktree absent after worktrees check in pass path', async () => {
    await runChecks({ cwd: passDir, worktrees: true });
    const wtPath = join(passDir, '.worktrees', 'preflight-test');
    assert.equal(existsSync(wtPath), false, 'worktree dir absent after run');
  });
});

// ── CLI --json output ─────────────────────────────────────────────────────────

describe('CLI --json output', () => {
  let dir;

  beforeEach((t) => {
    dir = initRepo(t);
  });

  it('outputs valid JSON with checks and verdict', () => {
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, '--json'],
      { cwd: dir, encoding: 'utf8' }
    );
    assert.ok(result.stdout.trim().length > 0, 'stdout must not be empty');
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed.checks), 'checks must be an array');
    assert.ok(typeof parsed.verdict === 'string', 'verdict must be a string');
    assert.ok(Array.isArray(parsed.failedNames), 'failedNames must be an array');
  });
});

// ── CLI --dir option ──────────────────────────────────────────────────────────

describe('CLI --dir option', () => {
  let dir;

  beforeEach((t) => {
    dir = initRepo(t);
  });

  it('passes --dir flag and writes to custom adlc directory', () => {
    const customDir = '.custom-adlc';
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, '--dir', customDir, '--json'],
      { cwd: dir, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    const writeCheck = parsed.checks.find((c) => c.name === 'write');
    assert.ok(writeCheck);
    assert.equal(writeCheck.status, 'pass');
    assert.match(writeCheck.detail, /\.custom-adlc\/tmp\/preflight-test written and removed/);
    assert.equal(existsSync(join(dir, '.adlc')), false, '.adlc should not have been created');
  });
});
