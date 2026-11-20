import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo } from '../lib/test-kit.mjs';
import { changedFiles } from '../lib/git.mjs';

test('changedFiles reports both old and new paths under git mv when diff.renames=true', (t) => {
  const { dir, git } = gitRepo(t);
  git('config', 'diff.renames', 'true');
  writeFileSync(join(dir, 'old-path.txt'), 'hello world\nline 2\nline 3\n');
  git('add', 'old-path.txt');
  git('commit', '-m', 'commit old');
  git('mv', 'old-path.txt', 'new-path.txt');
  const files = changedFiles('HEAD', dir);
  assert.ok(files.includes('old-path.txt'), 'changedFiles must report old path under git mv');
  assert.ok(files.includes('new-path.txt'), 'changedFiles must report new path under git mv');
});

test('changedFiles reports unstaged rename/delete+add paths with diff.renames=true', (t) => {
  const { dir, git } = gitRepo(t);
  git('config', 'diff.renames', 'true');
  writeFileSync(join(dir, 'source.txt'), 'unique content line 1\nunique content line 2\n');
  git('add', 'source.txt');
  git('commit', '-m', 'commit source');
  rmSync(join(dir, 'source.txt'));
  writeFileSync(join(dir, 'target.txt'), 'unique content line 1\nunique content line 2\n');
  git('add', '-N', 'target.txt');
  const files = changedFiles('HEAD', dir);
  assert.ok(files.includes('source.txt'), 'changedFiles must report old unstaged deleted path');
  assert.ok(files.includes('target.txt'), 'changedFiles must report new unstaged created path');
});
