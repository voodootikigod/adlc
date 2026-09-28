// Every git spawned with the suite's hermetic env runs auto-maintenance in the
// foreground, whether or not the call site adds its own -c flags. A detached
// `git maintenance run` outlives the command that spawned it and can create
// files under .git while the fixture's teardown is removing that directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp } from '@adlc/core/test-kit';
import { hermeticGitEnv } from './helpers/hermetic-git.mjs';

const git = (dir, args, extraEnv = {}) =>
  spawnSync('git', ['-C', dir, ...args], { env: { ...hermeticGitEnv, ...extraEnv }, encoding: 'utf8' });

test('hermetic env resolves gc.auto=0 and gc.autoDetach=false with no -c flags', (t) => {
  const dir = tmp(t, 'fleet-hermetic-git-');
  assert.equal(git(dir, ['init', '-q', '-b', 'main']).status, 0);
  assert.equal(git(dir, ['config', 'gc.auto']).stdout.trim(), '0');
  assert.equal(git(dir, ['config', 'gc.autoDetach']).stdout.trim(), 'false');
});

test('a bare git commit under the hermetic env never spawns detached maintenance', (t) => {
  const dir = tmp(t, 'fleet-hermetic-git-');
  assert.equal(git(dir, ['init', '-q', '-b', 'main']).status, 0);
  writeFileSync(join(dir, 'f'), 'x\n');
  assert.equal(git(dir, ['add', 'f']).status, 0);
  const commit = git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed'], { GIT_TRACE: '1' });
  assert.equal(commit.status, 0, commit.stderr);
  assert.doesNotMatch(commit.stderr, /maintenance run [^\n]*--detach/);
});
