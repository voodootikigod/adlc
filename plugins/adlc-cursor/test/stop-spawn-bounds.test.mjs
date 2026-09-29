// stop-spawn-bounds.test.mjs — a child that never exits must not hang the
// Cursor stop hook.
//
// stopAudit spawns `adlc` (manifest verify/show) and `git` (the changed-path
// scan). Without a timeout, spawnSync waits forever on a child that never
// exits; Cursor's per-hook timeout is the only other bound, and nothing that
// calls this module directly gets it.
//
// The tests must not be able to hang either, so every spawn goes through the
// bounded helper and every test declares its own timeout.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runHook } from './helpers/run-hook.mjs';
import { run, gitChangedPaths, stopAudit } from '../hooks/adlc-stop.mjs';

const STOP_HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'adlc-stop.mjs');

// The per-operation budget the hook allows a child program. Duplicated rather
// than imported: the constants are module-private, and a test that read them
// back would pass even if no spawn used them.
const BUDGET_MS = 5000;
const BOUND_MS = 2 * BUDGET_MS;
const HARD_KILL_MS = 30_000;

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 10_000 }).trim();

const SANDBOXES = [];
const sandbox = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  SANDBOXES.push(dir);
  return dir;
};

after(() => {
  for (const dir of SANDBOXES) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** A PATH directory whose `name` is a shell script that never exits. */
function blockingBin(name) {
  const dir = sandbox(`adlc-cursor-block-${name}-`);
  const bin = join(dir, name);
  writeFileSync(bin, '#!/bin/sh\nexec sleep 100000\n');
  chmodSync(bin, 0o755);
  return dir;
}

function initRepo(prefix) {
  const dir = sandbox(prefix);
  const git = (args) => execFileSync(REAL_GIT, args, {
    cwd: dir,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[]}');
  writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), '');
  writeFileSync(join(dir, 'README.md'), 'baseline\n');
  git(['add', '-A']);
  git(['commit', '-m', 'baseline']);
  writeFileSync(join(dir, 'README.md'), 'baseline\nchanged\n');
  return dir;
}

function runStopTimed(dir, fakeBinDir) {
  const started = Date.now();
  let timedOut = false;
  try {
    runHook([STOP_HOOK], {
      input: JSON.stringify({ workspace_roots: [dir] }),
      cwd: dir,
      timeout: HARD_KILL_MS,
      env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH ?? ''}` },
    });
  } catch (err) {
    if (err?.timedOut) timedOut = true;
    else throw err;
  }
  return { elapsed: Date.now() - started, timedOut };
}

test('a git that never exits cannot hang the stop hook, and the scan shares one budget', { timeout: 120_000 }, () => {
  const dir = initRepo('adlc-cursor-bound-git-');
  const { elapsed, timedOut } = runStopTimed(dir, blockingBin('git'));
  assert.equal(timedOut, false, 'the stop hook had to be killed — a blocked git still hangs it');
  assert.ok(elapsed < BOUND_MS, `stop with a blocked git took ${elapsed}ms, over ${BOUND_MS}ms — the budget is per call, not per scan`);
});

test('an adlc that never exits cannot hang the stop hook', { timeout: 120_000 }, () => {
  const dir = initRepo('adlc-cursor-bound-adlc-');
  const { elapsed, timedOut } = runStopTimed(dir, blockingBin('adlc'));
  assert.equal(timedOut, false, 'the stop hook had to be killed — a blocked adlc still hangs it');
  assert.ok(elapsed < BOUND_MS, `stop with a blocked adlc took ${elapsed}ms, over ${BOUND_MS}ms`);
});

function recordingSpawn(result = { status: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const impl = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return result;
  };
  return { impl, calls };
}

test('run() hands every spawn a positive timeout and a SIGKILL reap', () => {
  const { impl, calls } = recordingSpawn();
  run(impl, 'adlc', ['gate-manifest', 'verify'], '/tmp');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.killSignal, 'SIGKILL');
  assert.equal(calls[0].opts.timeout, BUDGET_MS);
  assert.equal(calls[0].opts.cwd, '/tmp');
});

test('run() never passes a zero or negative timeout, which spawnSync reads as unbounded', () => {
  const { impl, calls } = recordingSpawn();
  run(impl, 'git', ['status'], '/tmp', 0);
  run(impl, 'git', ['status'], '/tmp', -250);
  for (const { opts } of calls) assert.equal(opts.timeout, 1);
});

test('gitChangedPaths gives every git call a share of one scan budget', () => {
  const { impl, calls } = recordingSpawn({ status: 0, stdout: 'abc123\n', stderr: '' });
  gitChangedPaths('/tmp', { spawnImpl: impl, base: 'main' });
  assert.ok(calls.length >= 4, `expected the full scan, saw ${calls.length} calls`);
  for (const { bin, opts } of calls) {
    assert.equal(bin, 'git');
    assert.equal(opts.killSignal, 'SIGKILL');
    assert.ok(opts.timeout >= 1 && opts.timeout <= BUDGET_MS, `timeout ${opts.timeout} is outside (0, ${BUDGET_MS}]`);
  }
});

test('stopAudit bounds its manifest verify and show calls', () => {
  const root = sandbox('adlc-cursor-bound-audit-');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), '{"tickets":[]}');
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '');
  const calls = [];
  const impl = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    if (bin === 'git' && args[0] === 'status') return { status: 0, stdout: ' M src/auth/login.js\0', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  stopAudit(root, { spawnImpl: impl, env: {} });
  const adlcCalls = calls.filter((c) => c.bin === 'adlc');
  assert.deepEqual(adlcCalls.map((c) => c.args[1]), ['verify', 'show']);
  for (const { opts } of adlcCalls) {
    assert.equal(opts.killSignal, 'SIGKILL');
    assert.equal(opts.timeout, BUDGET_MS);
  }
});
