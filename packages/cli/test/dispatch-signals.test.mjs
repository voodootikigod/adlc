// The dispatcher must forward termination signals to the tool child.
//
// It used to run tools with spawnSync, which cannot forward anything: while the
// parent blocks in spawnSync Node cannot dispatch a signal handler at all, and no
// handler was registered anyway. Killing `adlc` by pid — a tool timeout, a CI
// cancellation, any supervisor — therefore killed the wrapper and ORPHANED the
// tool, which kept running against a tree whose owner thought the command was
// over. For `adlc hollow-test`, which mutates source in place, the orphan keeps
// mutating and its own SIGINT handler never fires, because the signal went to the
// wrapper instead.
//
// Interactive Ctrl-C masked all of this: a terminal signals the whole foreground
// process group, so both processes got it.
//
// These use REAL child processes and real handler wiring; only the signal
// delivery is synthesised (process.emit), so the test never has to signal itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dispatch } from '../lib/dispatch.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bounded, so a regression that stops forwarding FAILS rather than hangs. Without
// this the dispatch promise simply never settles (the child outlives the test) and
// the run wedges until the suite timeout — a far worse signal than a red assertion.
const TIMED_OUT = Symbol('timed out');
function within(promise, ms) {
  return Promise.race([promise, sleep(ms).then(() => TIMED_OUT)]);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

test('forwards a termination signal to the running tool child', async () => {
  let child = null;
  // A child that would outlive the test by far if nothing forwarded to it.
  const spawnFn = () => {
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
    return child;
  };

  const pending = dispatch('review', [], { spawnFn });
  for (let i = 0; i < 100 && (child === null || child.pid === undefined); i += 1) await sleep(20);
  assert.ok(child?.pid, 'child never started — test proves nothing');
  const pid = child.pid;

  process.emit('SIGTERM');
  const settled = await within(pending, 15000);
  assert.notEqual(settled, TIMED_OUT, 'dispatch never settled — the signal was not forwarded');

  assert.equal(alive(pid), false, `tool child ${pid} survived a signal sent to the dispatcher`);
  // Unchanged semantics: a signal-killed child is still reported as code 1.
  assert.equal(settled.code, 1);
  child.kill('SIGKILL');
});

test('forwards SIGINT and SIGHUP as well, not just SIGTERM', async () => {
  for (const signal of ['SIGINT', 'SIGHUP']) {
    let child = null;
    const spawnFn = () => {
      child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
      return child;
    };
    const pending = dispatch('review', [], { spawnFn });
    for (let i = 0; i < 100 && (child === null || child.pid === undefined); i += 1) await sleep(20);
    assert.ok(child?.pid, `child never started for ${signal}`);
    const pid = child.pid;

    process.emit(signal);
    const settled = await within(pending, 15000);
    assert.notEqual(settled, TIMED_OUT, `dispatch never settled — ${signal} was not forwarded`);

    assert.equal(alive(pid), false, `tool child survived ${signal} sent to the dispatcher`);
    child.kill('SIGKILL');
  }
});

test('removes its signal handlers once the child exits', async () => {
  const before = {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
    SIGHUP: process.listenerCount('SIGHUP'),
  };

  const spawnFn = () => spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await dispatch('review', [], { spawnFn });
  await dispatch('review', [], { spawnFn });

  // A listener left behind per dispatch leaks, and long-lived embedders would hit
  // MaxListenersExceededWarning.
  for (const [signal, count] of Object.entries(before)) {
    assert.equal(process.listenerCount(signal), count, `${signal} listener leaked`);
  }
});
