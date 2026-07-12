import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapResult } from '../lib/adapters/_shared.mjs';

// mapResult is load-bearing: every adapter routes its spawn result through it, so
// each timedOut trigger must be pinned IN ISOLATION (not all at once).

test('a clean zero exit → exitCode 0, not timed out', () => {
  assert.deepEqual(mapResult({ status: 0, stdout: 'ok', stderr: '' }), { exitCode: 0, output: 'ok', timedOut: false });
});

test('a non-zero exit is preserved', () => {
  assert.equal(mapResult({ status: 7, stderr: 'x' }).exitCode, 7);
});

test('SIGTERM alone marks timedOut (no killed/timedOut fields)', () => {
  const r = mapResult({ status: null, signal: 'SIGTERM' });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, 124);
});

test('res.killed alone marks timedOut', () => {
  const r = mapResult({ status: null, killed: true });
  assert.equal(r.timedOut, true);
});

test('res.timedOut alone marks timedOut', () => {
  const r = mapResult({ status: null, timedOut: true });
  assert.equal(r.timedOut, true);
});

test('a normal signal-less null status is NOT timedOut but is non-zero', () => {
  const r = mapResult({ status: null });
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 1);
});

test('output concatenates stdout + stderr', () => {
  assert.equal(mapResult({ status: 0, stdout: 'a', stderr: 'b' }).output, 'ab');
});
