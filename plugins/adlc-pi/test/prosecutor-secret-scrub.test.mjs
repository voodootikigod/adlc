// prosecutor-secret-scrub.test.mjs — defaultRunLens's child env must never
// carry ADLC_MANIFEST_KEY/ADLC_ADMIN_KEY, even though the lens prompt embeds
// attacker-influenced diff text (issue #843). Drives a fake spawnFn (the
// established DI shape in this monorepo — see packages/fleet/lib/
// egress-bridge.mjs's `spawnFn = spawn`) so no real `pi` child is ever
// launched under `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { defaultRunLens } from '../lib/prosecutor.mjs';

/** A fake child_process.ChildProcess: stdout/stderr streams + exit/error events. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

/** A fake spawnFn that records the (cmd, args, opts) it was called with and
 * lets the test drive the returned child's completion. */
function makeSpawnFn() {
  const calls = [];
  let lastChild = null;
  const spawnFn = (cmd, args, opts) => {
    const child = fakeChild();
    calls.push({ cmd, args, opts });
    lastChild = child;
    return child;
  };
  return { spawnFn, calls, finish: (text = '[]') => {
    lastChild.stdout.emit('data', Buffer.from(text));
    lastChild.emit('exit', 0);
  } };
}

test('AC1: the child env carries neither ADLC_MANIFEST_KEY nor ADLC_ADMIN_KEY', async () => {
  const origKey = process.env.ADLC_MANIFEST_KEY;
  const origAdmin = process.env.ADLC_ADMIN_KEY;
  process.env.ADLC_MANIFEST_KEY = 'super-secret-signing-key';
  process.env.ADLC_ADMIN_KEY = 'super-secret-admin-key';
  try {
    const { spawnFn, calls, finish } = makeSpawnFn();
    const runLens = defaultRunLens('/repo', { spawnFn });
    const resultPromise = runLens('=== DIFF ===\nsome attacker-influenced diff text', {});
    finish('[]');
    await resultPromise;

    assert.equal(calls.length, 1);
    const { env } = calls[0].opts;
    assert.ok(env, 'spawn must receive an explicit env option');
    assert.equal(env.ADLC_MANIFEST_KEY, undefined, 'ADLC_MANIFEST_KEY must not reach the lens child');
    assert.equal(env.ADLC_ADMIN_KEY, undefined, 'ADLC_ADMIN_KEY must not reach the lens child');
  } finally {
    if (origKey === undefined) delete process.env.ADLC_MANIFEST_KEY; else process.env.ADLC_MANIFEST_KEY = origKey;
    if (origAdmin === undefined) delete process.env.ADLC_ADMIN_KEY; else process.env.ADLC_ADMIN_KEY = origAdmin;
  }
});

test('AC2: every other env var is passed through unchanged', async () => {
  const marker = `probe-${Date.now()}`;
  process.env.ADLC_PI_TEST_PROBE = marker;
  try {
    const { spawnFn, calls, finish } = makeSpawnFn();
    const runLens = defaultRunLens('/repo', { spawnFn });
    const resultPromise = runLens('a benign prompt', {});
    finish('[]');
    await resultPromise;

    const { env } = calls[0].opts;
    assert.equal(env.ADLC_PI_TEST_PROBE, marker, 'unrelated env vars must survive the scrub');
    // A representative always-present var, to catch an over-broad scrub that
    // dropped the whole env rather than the two named keys.
    assert.ok(env.PATH, 'PATH must survive the scrub');
  } finally {
    delete process.env.ADLC_PI_TEST_PROBE;
  }
});

test('AC3: the real process.env is unmutated after the call — the scrub operates on a copy', async () => {
  process.env.ADLC_MANIFEST_KEY = 'still-here-in-the-parent';
  try {
    const { spawnFn, finish } = makeSpawnFn();
    const runLens = defaultRunLens('/repo', { spawnFn });
    const resultPromise = runLens('another prompt', {});
    finish('[]');
    await resultPromise;

    assert.equal(process.env.ADLC_MANIFEST_KEY, 'still-here-in-the-parent', 'the parent process env must be untouched');
  } finally {
    delete process.env.ADLC_MANIFEST_KEY;
  }
});

test('AC4: regression — cwd, argv, and stdout parsing are unchanged by the scrub', async () => {
  const { spawnFn, calls, finish } = makeSpawnFn();
  const runLens = defaultRunLens('/some/repo/root', { spawnFn });
  const resultPromise = runLens('the prompt text', {});
  finish('lens output text');
  const out = await resultPromise;

  assert.equal(out, 'lens output text');
  assert.deepEqual(calls[0].args, ['-p', 'the prompt text', '--no-session']);
  assert.equal(calls[0].opts.cwd, '/some/repo/root');
});

test('regression: no injected spawnFn still defaults to the real node:child_process spawn (no crash on construction)', () => {
  // Constructing the runner must not throw even without an injected spawnFn —
  // it should default to the real `spawn`. We do not invoke it (that would
  // launch a real, likely-absent `pi` binary); this only proves the default
  // parameter wiring is present.
  assert.doesNotThrow(() => defaultRunLens('/repo'));
});
