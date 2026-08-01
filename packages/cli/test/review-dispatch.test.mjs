import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { dispatch } from '../lib/dispatch.mjs';
import { getTool, isTool } from '../lib/registry.mjs';
import { renderHelp } from '../lib/help.mjs';

// The injected spawn now returns a ChildProcess rather than a spawnSync result,
// because the dispatcher has to stay on the event loop to forward signals to the
// tool child (see runChild in lib/dispatch.mjs). These fakes model just enough of
// that surface: an 'exit'/'error' event and a kill().
function fakeChild({ status = 0, signal = null, error = null } = {}) {
  const child = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    if (error) child.emit('error', error);
    else child.emit('exit', status, signal);
  });
  return child;
}

// Issue #65: packages/prosecute is a P5 evidence recorder, not the model reviewer.
// The actual adversarial engine lives in the separate `adversarial-review` CLI
// (`npx adversarial-review`), which was previously unreachable from the `adlc`
// dispatcher. These tests confirm `adlc review` routes to it via npx passthrough,
// without ever spawning a real child process (the spawn call is injected/mocked).

test('registry registers "review" as an external npx-routed verb, not a workspace package', () => {
  assert.equal(isTool('review'), true);
  const tool = getTool('review');
  assert.ok(tool);
  assert.equal(tool.external, true);
  assert.equal(tool.packageName, 'adversarial-review');
  assert.equal(tool.name, 'review');
});

test('help output lists the review verb', () => {
  const output = renderHelp('1.0.0');
  assert.match(output, /\breview\b/);
  assert.match(output, /adversarial-review/);
});

test('dispatching "review" shells out to `npx adversarial-review` with full argument passthrough', async () => {
  const calls = [];
  const spawnFn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return fakeChild({ status: 0 });
  };

  const { code, error } = await dispatch('review', ['--scope', 'working-tree', '--include-files'], { spawnFn });

  assert.equal(error, undefined);
  assert.equal(code, 0);
  assert.equal(calls.length, 1, 'expected exactly one spawn call (no network access)');
  assert.equal(calls[0].cmd, 'npx');
  assert.deepEqual(calls[0].args, ['adversarial-review', '--scope', 'working-tree', '--include-files']);
  assert.equal(calls[0].options.stdio, 'inherit');
});

test('dispatching "review" propagates the underlying tool\'s exit code', async () => {
  const spawnFn = () => fakeChild({ status: 2 });
  const { code } = await dispatch('review', [], { spawnFn });
  assert.equal(code, 2);
});

test('dispatching "review" surfaces a spawn error instead of throwing', async () => {
  const spawnFn = () => fakeChild({ error: new Error('npx not found') });
  const { code, error } = await dispatch('review', [], { spawnFn });
  assert.equal(code, 1);
  assert.match(error, /npx not found/);
});

test('dispatching "review" surfaces a synchronous spawn failure instead of throwing', async () => {
  // Distinct from the async child.on('error') case above: here spawnFn() itself
  // throws before a child ever exists (e.g. EAGAIN from the OS), exercising the
  // try/catch around the spawnFn call in runChild rather than the 'error' event.
  const spawnFn = () => {
    throw new Error('EAGAIN spawn failed');
  };
  const { code, error } = await dispatch('review', [], { spawnFn });
  assert.equal(code, 1);
  assert.match(error, /EAGAIN spawn failed/);
});
