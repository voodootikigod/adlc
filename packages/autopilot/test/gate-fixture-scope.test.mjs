// The coverage gate calls exported criterion functions directly, outside any
// node:test callback. Every kit fixture those functions mint must still be
// removed: the gate supplies a scoped context and drains it when the call
// settles, whether the call passed or threw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { GATE_EXEC_KEY } from './helpers/node-test.mjs';
import { runRegistered } from './helpers/run-registered.mjs';
import { REGISTRY } from './ac-registry.mjs';

const HERE = new URL('.', import.meta.url);
const FAST_FILES = new Set(['tools.test.mjs', 'paths.test.mjs', 'init.test.mjs', 'input.test.mjs', 'lock.test.mjs']);

/** Runs fn with os.tmpdir() pointed at a fresh private directory; returns what is left in it. */
async function leftoversOf(fn) {
  const saved = process.env.TMPDIR;
  const priv = mkdtempSync(join(tmpdir(), 'ap-gate-scope-'));
  process.env.TMPDIR = priv;
  try {
    await fn();
    return readdirSync(priv);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    rmSync(priv, { recursive: true, force: true });
  }
}

test('runRegistered passes a context and removes its fixtures once the call settles', async () => {
  let dir;
  await runRegistered((t) => { dir = tmp(t, 'ap-gate-scope-ok-'); assert.ok(existsSync(dir)); });
  assert.equal(existsSync(dir), false);
});

test('runRegistered removes the fixtures of a call that throws, and rethrows', async () => {
  let dir;
  await assert.rejects(runRegistered((t) => { dir = tmp(t, 'ap-gate-scope-bad-'); throw new Error('criterion failed'); }), /criterion failed/);
  assert.equal(existsSync(dir), false);
});

test('context-taking criterion functions run the way the gate runs them leave no directory behind', async () => {
  globalThis[GATE_EXEC_KEY] = true; // import the criterion files without registering their tests here
  const entries = Object.values(REGISTRY).flat().filter((e) => !e.manual && FAST_FILES.has(e.file));
  const fns = [];
  for (const e of entries) {
    const fn = (await import(pathToFileURL(join(HERE.pathname, e.file)).href))[e.fn];
    if (typeof fn === 'function' && fn.length === 1) fns.push(fn);
  }
  globalThis[GATE_EXEC_KEY] = false;
  assert.ok(fns.length >= 5, `expected the context-taking criteria of ${[...FAST_FILES].join(', ')}, found ${fns.length}`);
  const left = await leftoversOf(async () => { for (const fn of fns) await runRegistered(fn); });
  assert.deepEqual(left, [], `criterion fixtures outlived the gate call: ${left.join(', ')}`);
});
