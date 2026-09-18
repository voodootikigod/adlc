// spawn-timeout.test.mjs — a blocked child must never hang the hook (#1044).
//
// `runAdlc` and `gitChangedPaths` spawn `adlc` and `git` synchronously. Without
// a timeout, spawnSync waits forever on a child that never exits, and the only
// thing bounding that in production is adlc-hook-run.mjs's own per-mode
// self-termination. Anything calling the hook body directly — every test in this
// directory — had no bound at all: a `git` that blocks made the review suite run
// until something outside killed it (observed in the wild as 12-process trees
// still alive after 4 days).
//
// THE TESTS MUST NOT BE ABLE TO HANG EITHER, which is the whole point, so every
// spawn here carries its own `timeout` and every test declares one. A regression
// makes execFileSync throw ETIMEDOUT and the assertion fail; it never wedges the
// runner.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-hook.mjs');

// The budget the hook allows each of its two child programs. Kept in sync with
// adlc-hook.mjs by the assertions below rather than imported: these constants are
// module-private there, and a test that reached in to read them would pass even
// if the spawn never used them.
const BUDGET_MS = 5000;
// Two budgets' worth of slack covers node startup plus the SIGKILL round trip.
// The point is the bound, not the exact figure: a hung spawn blows past any of
// these by orders of magnitude (the real one ran for days).
const BOUND_MS = 2 * BUDGET_MS;
// Well past BOUND_MS, so a regression fails on the elapsed assertion or on this
// throwing — never by hanging the suite.
const HARD_KILL_MS = 30_000;

/** The real git, resolved BEFORE any fake is put on PATH. */
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 10_000 }).trim();

const SANDBOXES = [];
const sandbox = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  SANDBOXES.push(dir);
  return dir;
};

/**
 * A directory holding one executable `name` that never exits.
 *
 * `exec sleep` rather than `sleep &`: the shim must BE the sleeping process, so
 * the SIGKILL that spawnSync's timeout sends actually reaps it instead of
 * leaving an orphan behind — the failure mode this whole file is about.
 */
function blockingBin(name) {
  const dir = sandbox(`adlc-blockbin-${name}-`);
  const bin = join(dir, name);
  writeFileSync(bin, '#!/bin/sh\nexec sleep 100000\n');
  chmodSync(bin, 0o755);
  return dir;
}

/** A throwaway ADLC-initialized git repo, built with the REAL git. */
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
  writeFileSync(join(dir, 'README.md'), 'baseline\n');
  git(['add', '-A']);
  git(['commit', '-m', 'baseline']);
  // An uncommitted edit, so the review hook has a reason to ask git what changed.
  writeFileSync(join(dir, 'README.md'), 'baseline\nchanged\n');
  return dir;
}

/**
 * Run one hook mode with `fakeBinDir` first on PATH, and return how long it took.
 *
 * A non-zero exit is not a failure here: these modes are advisory and may print
 * nothing. The subject is whether the process RETURNS.
 */
function runHookTimed(mode, { cwd, fakeBinDir }) {
  const started = Date.now();
  let timedOut = false;
  try {
    execFileSync(process.execPath, [HOOK, mode], {
      input: JSON.stringify({ cwd }),
      encoding: 'utf8',
      cwd,
      timeout: HARD_KILL_MS,
      killSignal: 'SIGKILL',
      env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH ?? ''}` },
    });
  } catch (err) {
    if (err?.code === 'ETIMEDOUT' || err?.signal === 'SIGKILL') timedOut = true;
  }
  return { elapsed: Date.now() - started, timedOut };
}

test('AC1/AC2: a git that never exits cannot hang the review hook, and the whole scan shares one budget', { timeout: 120_000 }, () => {
  const dir = initRepo('adlc-spawn-timeout-git-');
  const { elapsed, timedOut } = runHookTimed('review', { cwd: dir, fakeBinDir: blockingBin('git') });

  assert.equal(timedOut, false, `the review hook had to be killed after ${HARD_KILL_MS}ms — a blocked git still hangs it`);
  // AC2: gitChangedPaths issues SEVERAL git commands. Per-call timeouts would
  // cost N x the budget; one whole-operation budget keeps the total near it.
  assert.ok(
    elapsed < BOUND_MS,
    `review with a blocked git took ${elapsed}ms, over the ${BOUND_MS}ms bound — the budget is per call, not per scan`
  );
});

test('AC3: an adlc that never exits cannot hang the preflight hook', { timeout: 120_000 }, () => {
  const dir = initRepo('adlc-spawn-timeout-adlc-');
  const { elapsed, timedOut } = runHookTimed('preflight', { cwd: dir, fakeBinDir: blockingBin('adlc') });

  assert.equal(timedOut, false, `the preflight hook had to be killed after ${HARD_KILL_MS}ms — a blocked adlc still hangs it`);
  assert.ok(elapsed < BOUND_MS, `preflight with a blocked adlc took ${elapsed}ms, over the ${BOUND_MS}ms bound`);
});

after(() => {
  for (const dir of SANDBOXES) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
