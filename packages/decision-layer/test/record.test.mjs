// The run-log writer: creating .adlc and .adlc/decisions is race-safe (a
// directory another run created between this run's check and its mkdir is
// used, not treated as a failure), and a symbolic link is still refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { installNoNetwork } from './helpers/no-network.mjs';
import { BIN, changeRepo } from './helpers/fixtures.mjs';
import { NO_NETWORK_PRELOAD } from './helpers/no-network.mjs';
import { appendRecord, recordPath } from '../lib/record.mjs';
import { RecordError } from '../lib/errors.mjs';

installNoNetwork();

/**
 * Make lstat report `target` missing once, after `onMiss` has run, then behave
 * normally: the window a concurrent creator uses between a check and a mkdir.
 */
function missOnce(t, target, onMiss) {
  const real = fs.lstatSync;
  let missed = false;
  fs.lstatSync = (path, ...rest) => {
    if (!missed && path === target) {
      missed = true;
      onMiss();
      throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: 'ENOENT' });
    }
    return real(path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.lstatSync = real;
    syncBuiltinESMExports();
  });
}

for (const segment of ['.adlc', join('.adlc', 'decisions')]) {
  test(`a ${segment} directory created by another run between the check and the mkdir is used`, (t) => {
    const root = tmp(t, 'decision-record-race-');
    const target = join(root, segment);
    missOnce(t, target, () => mkdirSync(target, { recursive: true }));
    appendRecord(root, { n: 1 });
    assert.equal(readFileSync(recordPath(root), 'utf8'), '{"n":1}\n');
  });
}

test('a symbolic link created by another run in that window is still refused', (t) => {
  const root = tmp(t, 'decision-record-race-');
  const outside = tmp(t, 'decision-record-outside-');
  mkdirSync(join(root, '.adlc'));
  const target = join(root, '.adlc', 'decisions');
  missOnce(t, target, () => symlinkSync(outside, target));
  assert.throws(() => appendRecord(root, { n: 1 }), (error) => error instanceof RecordError && /symbolic link/.test(error.message));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('a file created by another run in that window is refused', (t) => {
  const root = tmp(t, 'decision-record-race-');
  mkdirSync(join(root, '.adlc'));
  const target = join(root, '.adlc', 'decisions');
  missOnce(t, target, () => fs.writeFileSync(target, 'not a directory'));
  assert.throws(() => appendRecord(root, { n: 1 }), (error) => error instanceof RecordError && /decisions is not a directory$/.test(error.message));
});

function runDecision(t, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'evaluate', '--mode', 'shadow', '--provider', 'mock', '--model', 'm', '--pack', 'change-risk-v1'], {
      cwd,
      env: { PATH: process.env.PATH, HOME: tmp(t, 'decision-home-'), TYPESAFE_API_KEY: '', JEV_API_KEY: '', NODE_OPTIONS: `--import=${NO_NETWORK_PRELOAD}` },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stderr }); });
  });
}

test('concurrent first runs from two worktrees both record', async (t) => {
  for (let round = 0; round < 4; round += 1) {
    const { dir, git } = changeRepo(t);
    git('rm', '-q', '-r', '--cached', '.adlc');
    fs.rmSync(join(dir, '.adlc'), { recursive: true, force: true });
    const worktree = join(tmp(t, 'decision-race-wt-'), 'wt');
    git('worktree', 'add', '-q', worktree, '-b', `race-${round}`, 'feature');
    const results = await Promise.all([runDecision(t, dir), runDecision(t, worktree)]);
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(recordPath(dir), 'utf8').trim().split('\n').length, 2, `round ${round}`);
  }
});
