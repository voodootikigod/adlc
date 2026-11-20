import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitWorker, resetWorktree } from '../lib/worktrees.mjs';

const g = (dir) => (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim();

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'self-commit-'));
  try {
    const git = g(dir);
    git('init', '-q');
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    fn({ dir, git, tip: git('rev-parse', 'HEAD') });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('commitWorker returns HEAD sha when worker already committed ahead of cutTip and throws when at cutTip with clean tree', () => {
  withRepo(({ dir, git, tip }) => {
    assert.throws(() => commitWorker(dir, 'T-1', git, { cutTip: tip }));
    writeFileSync(join(dir, 'b.txt'), 'b');
    git('add', '-A');
    git('commit', '-q', '-m', 'worker self commit');
    const head = git('rev-parse', 'HEAD');
    assert.notEqual(head, tip);
    assert.equal(commitWorker(dir, 'T-1', git, { cutTip: tip }), head);

    // If new uncommitted changes exist alongside an earlier self-commit and commit fails, rethrow instead of dropping them.
    writeFileSync(join(dir, 'c.txt'), 'uncommitted');
    const failingCommitGit = (...args) => {
      if (args[0] === 'commit') throw new Error('gpg failed to sign the data');
      return git(...args);
    };
    assert.throws(() => commitWorker(dir, 'T-1', failingCommitGit, { cutTip: tip }), /gpg failed/);
  });
});

test('resetWorktree resets HEAD to cutTip between strikes', () => {
  withRepo(({ dir, git, tip }) => {
    git('tag', 'x', tip);
    writeFileSync(join(dir, 'b.txt'), 'b');
    git('add', '-A');
    git('commit', '-q', '-m', 'strike 1');
    writeFileSync(join(dir, 'junk.txt'), 'j');
    resetWorktree(dir, git, 'x');
    assert.equal(git('rev-parse', 'HEAD'), tip);
    assert.ok(!existsSync(join(dir, 'b.txt')));
    assert.ok(!existsSync(join(dir, 'junk.txt')));
  });
});
