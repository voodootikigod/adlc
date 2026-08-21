// supervise-runtime.test.mjs — the decisions the supervisor's real
// dependencies make: what argv a child gets, what environment it gets, how the
// continue step is invoked, and what a non-zero exit from it means.
//
// These live in lib/ rather than in the CLI branch precisely so they can be
// driven here; the loop that consumes them is covered by supervise-loop.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { terminateChild } from '../lib/supervise.mjs';
import {
  splitPassthrough,
  childArgv,
  nodeSpawner,
  cliContinueRunner,
  createInterrupt,
  statTranscriptFile,
  runNodeScript,
  HANDOFF_BIN,
} from '../lib/supervise-runtime.mjs';
import { CHILD_SESSION_ENV_MARKERS } from '../lib/supervise.mjs';

/**
 * Every async test here drives the loop, whose waits (for a deny, for
 * quiescence, for the child to exit) are deliberately unbounded — that is
 * correct for a wrapper attached to somebody's session, and wrong for a test.
 * Without a bound, a regression that removes a loop-exit guard SPINS instead of
 * failing, and `node --test` has no default timeout: CI would stall to the job
 * limit with no test named. This converts that class of regression into a named
 * failure. Generous on purpose — the fake clock makes these run in
 * milliseconds, so anything near this bound is a hang, not slow work.
 */
const LOOP_TEST = { timeout: 30_000 };

/** Minimal stand-in for a ChildProcess: `once` handlers plus a kill recorder. */
function fakeProcess() {
  const handlers = {};
  return {
    pid: 4242,
    killed: [],
    once(event, fn) {
      handlers[event] = fn;
      return this;
    },
    // Models node's REAL contract: true when the signal was delivered, false
    // for a reaped child. A stub that returned undefined here is what let a
    // `kill(...) === false` guard pass its unit test while being unreachable
    // in production.
    killReturns: true,
    kill(signal) {
      this.killed.push(signal);
      return this.killReturns;
    },
    fire(event, ...args) {
      handlers[event]?.(...args);
    },
  };
}

test('splitPassthrough requires the separator and keeps both sides intact', () => {
  const ok = splitPassthrough(['--dir', '.adlc', '--', 'claude', '--model', 'opus']);
  assert.deepEqual(ok, { ok: true, flags: ['--dir', '.adlc'], command: 'claude', args: ['--model', 'opus'] });

  const bare = splitPassthrough(['--', 'claude']);
  assert.deepEqual(bare, { ok: true, flags: [], command: 'claude', args: [] });

  const missing = splitPassthrough(['claude']);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /after `--`/);

  const empty = splitPassthrough(['--dir', '.adlc', '--']);
  assert.equal(empty.ok, false);

  assert.equal(splitPassthrough(undefined).ok, false);
});

test('childArgv leads with the minted session id and trails with the prompt', () => {
  assert.deepEqual(childArgv({ sessionId: 'sess-1', prompt: null, args: ['--model', 'opus'] }), [
    '--session-id',
    'sess-1',
    '--model',
    'opus',
  ]);
  assert.deepEqual(childArgv({ sessionId: 'sess-2', prompt: 'continue this', args: [] }), [
    '--session-id',
    'sess-2',
    'continue this',
  ]);
  // An empty prompt is not a prompt — appending it would submit a blank turn.
  assert.deepEqual(childArgv({ sessionId: 'sess-3', prompt: '', args: [] }), ['--session-id', 'sess-3']);
});

test('nodeSpawner scrubs the child environment on EVERY spawn', () => {
  const calls = [];
  const spawnFn = (command, args, opts) => {
    calls.push({ command, args, opts });
    return fakeProcess();
  };
  const env = {
    PATH: '/usr/bin',
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'parent',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    ADLC_MANIFEST_KEY: 'k'.repeat(64),
  };
  const spawn = nodeSpawner({ command: 'claude', args: ['--model', 'opus'], cwd: '/repo', env, spawnFn });

  spawn({ sessionId: 'sess-1', prompt: null });
  spawn({ sessionId: 'sess-2', prompt: 'continue' });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, 'claude');
    assert.equal(call.opts.cwd, '/repo');
    assert.equal(call.opts.stdio, 'inherit');
    for (const marker of CHILD_SESSION_ENV_MARKERS) {
      assert.equal(call.opts.env[marker], undefined, `${marker} reached spawn ${call.args[1]}`);
    }
    assert.equal(call.opts.env.ADLC_MANIFEST_KEY, undefined, 'the key never reaches the harness child');
    assert.equal(call.opts.env.PATH, '/usr/bin');
  }
  assert.deepEqual(calls[0].args, ['--session-id', 'sess-1', '--model', 'opus']);
  assert.deepEqual(calls[1].args, ['--session-id', 'sess-2', '--model', 'opus', 'continue']);
});

test('a spawned handle settles on exit, on error, and swallows a kill that cannot land', LOOP_TEST, async () => {
  const proc = fakeProcess();
  const spawn = nodeSpawner({ command: 'claude', cwd: '/repo', env: {}, spawnFn: () => proc });
  const handle = spawn({ sessionId: 'sess-1', prompt: null });
  assert.equal(handle.kill('SIGTERM'), true, 'a delivered signal must report as delivered');
  assert.deepEqual(proc.killed, ['SIGTERM']);
  proc.fire('exit', 0, null);
  assert.deepEqual(await handle.exited, { code: 0, signal: null });

  const broken = fakeProcess();
  broken.kill = () => {
    throw new Error('ESRCH');
  };
  const spawn2 = nodeSpawner({ command: 'claude', cwd: '/repo', env: {}, spawnFn: () => broken });
  const handle2 = spawn2({ sessionId: 'sess-2', prompt: null });
  assert.equal(
    handle2.kill('SIGTERM'),
    false,
    'a kill that throws must report the same "already gone" fact node reports as false',
  );
  broken.fire('error', new Error('spawn ENOENT'));
  const settled = await handle2.exited;
  assert.equal(settled.code, null);
  assert.match(settled.error.message, /ENOENT/, 'a command that never started must settle, not hang the loop');
});

test('handle.kill forwards a REAL child process\'s answer, so the already-gone guard is reachable', LOOP_TEST, async () => {
  // The production proof. Everything above this runs against a stub, and a stub
  // is exactly what hid this: the wrapper discarded child.kill()'s return, so
  // it always yielded undefined, and terminateChild's `=== false` guard could
  // never fire outside a test. Node's own contract — true for a live child,
  // false for a reaped one — is what the guard is written against, so it is
  // verified here against node rather than assumed.
  const spawn = nodeSpawner({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    env: process.env,
  });

  const live = spawn({ sessionId: 'sess-live', prompt: null });
  assert.equal(live.kill('SIGTERM'), true, 'a live child accepts the signal');
  const liveExit = await live.exited;
  assert.equal(liveExit.signal, 'SIGTERM');

  // Same handle, now that the child has been reaped.
  assert.equal(
    live.kill('SIGTERM'),
    false,
    'a reaped child reports false — this is the value terminateChild keys "already gone" on',
  );

  // And that value really does drive the guard: terminateChild must report
  // signalled:false for a child whose kill says it is already gone.
  const ended = await terminateChild(
    { hasExited: () => false, exit: () => null },
    {
      sleep: async () => {},
      now: () => 0,
      pollMs: 1,
      graceMs: 1,
      kill: (signal) => live.kill(signal),
    },
  );
  assert.equal(ended.signalled, false, 'the real return must reach the guard, not just a stub value');
});

test('the spawner hands each child to the interrupt so Ctrl-C reaches the live one', () => {
  const signals = { on() {}, off() {} };
  const interrupt = createInterrupt({ signals });
  const procs = [fakeProcess(), fakeProcess()];
  let n = 0;
  const spawn = nodeSpawner({
    command: 'claude',
    cwd: '/repo',
    env: {},
    spawnFn: () => procs[n++],
    onSpawn: (child) => interrupt.attach(child),
  });

  spawn({ sessionId: 'sess-1', prompt: null });
  spawn({ sessionId: 'sess-2', prompt: 'go' });
  interrupt.raise();

  assert.equal(interrupt.isStopped(), true);
  assert.deepEqual(procs[0].killed, [], 'the superseded child is not the one holding the terminal');
  assert.deepEqual(procs[1].killed, ['SIGINT']);
});

test('createInterrupt registers and removes its handler', () => {
  const added = [];
  const removed = [];
  const signals = {
    on: (name, fn) => added.push([name, fn]),
    off: (name, fn) => removed.push([name, fn]),
  };
  const interrupt = createInterrupt({ signals });
  assert.equal(added.length, 1);
  assert.equal(added[0][0], 'SIGINT');
  interrupt.dispose();
  assert.deepEqual(removed[0], added[0]);
  // A raise with nothing attached still stops the loop rather than throwing.
  interrupt.raise();
  assert.equal(interrupt.isStopped(), true);
});

test('cliContinueRunner builds the mutating invocation and passes the key through', LOOP_TEST, async () => {
  const calls = [];
  const run = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { code: 0, stdout: JSON.stringify({ dryRun: false, successor_session_id: 's' }), stderr: '' };
  };
  const env = { ADLC_MANIFEST_KEY: 'k'.repeat(64) };
  const runner = cliContinueRunner({ cwd: '/repo', dir: '/repo/.adlc', env, run });

  const withCapture = await runner({ denySession: 'sess-1', captureFrom: '/t/sess-1.jsonl' });
  assert.equal(withCapture.ok, true);
  assert.deepEqual(withCapture.payload, { dryRun: false, successor_session_id: 's' });
  assert.equal(calls[0].bin, HANDOFF_BIN);
  assert.deepEqual(calls[0].args, [
    'continue',
    '--deny-session',
    'sess-1',
    '--dir',
    '/repo/.adlc',
    '--write',
    '--json',
    '--capture-from',
    '/t/sess-1.jsonl',
  ]);
  assert.equal(calls[0].opts.cwd, '/repo');
  assert.equal(
    calls[0].opts.env.ADLC_MANIFEST_KEY,
    'k'.repeat(64),
    'the continue step is the ONLY place the key is used',
  );

  await runner({ denySession: 'sess-1', captureFrom: null });
  assert.equal(calls[1].args.includes('--capture-from'), false, 'no transcript, no flag');
});

test('cliContinueRunner turns every failure into a degrade the operator can read', LOOP_TEST, async () => {
  const degraded = await cliContinueRunner({
    cwd: '/repo',
    dir: '.adlc',
    env: {},
    run: async () => ({ code: 2, stdout: '', stderr: 'handoff continue: deny is unbound\n' }),
  })({ denySession: 'sess-1', captureFrom: null });
  assert.equal(degraded.ok, false);
  assert.match(degraded.error, /exited 2/);
  assert.match(degraded.error, /deny is unbound/);

  const opError = await cliContinueRunner({
    cwd: '/repo',
    dir: '.adlc',
    env: {},
    run: async () => ({ code: 1, stdout: '', stderr: 'ADLC_MANIFEST_KEY is required\n' }),
  })({ denySession: 'sess-1', captureFrom: null });
  assert.equal(opError.ok, false, 'exit 1 leaves just as little consumed as exit 2');
  assert.match(opError.error, /exited 1/);

  const garbage = await cliContinueRunner({
    cwd: '/repo',
    dir: '.adlc',
    env: {},
    run: async () => ({ code: 0, stdout: 'not json', stderr: '' }),
  })({ denySession: 'sess-1', captureFrom: null });
  assert.equal(garbage.ok, false);
  assert.match(garbage.error, /JSON payload/);
});

test('runNodeScript reports a non-zero exit rather than throwing', LOOP_TEST, async () => {
  const ok = await runNodeScript('-e', ['process.stdout.write("hi")'], {
    cwd: process.cwd(),
    env: process.env,
    execFileFn: (bin, args, opts, cb) => cb(null, 'hi', ''),
  });
  assert.deepEqual(ok, { code: 0, stdout: 'hi', stderr: '' });

  const failed = await runNodeScript('x.mjs', [], {
    cwd: process.cwd(),
    env: process.env,
    execFileFn: (bin, args, opts, cb) => cb(Object.assign(new Error('exit 2'), { code: 2 }), '', 'boom'),
  });
  assert.deepEqual(failed, { code: 2, stdout: '', stderr: 'boom' });

  const signalled = await runNodeScript('x.mjs', [], {
    cwd: process.cwd(),
    env: process.env,
    // A child killed by a signal reports a string `code` (or none at all).
    execFileFn: (bin, args, opts, cb) => cb(Object.assign(new Error('killed'), { code: 'ENOENT' }), '', ''),
  });
  assert.equal(signalled.code, 1, 'a non-numeric failure is still a failure');
});

test('statTranscriptFile reports the mtime it finds and null for a file that is not there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'supervise-stat-'));
  try {
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, '{}\n');
    const when = new Date('2026-08-13T12:00:00Z');
    utimesSync(path, when, when);
    assert.equal(statTranscriptFile(path).mtimeMs, when.getTime());
    assert.equal(statTranscriptFile(join(dir, 'missing.jsonl')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
