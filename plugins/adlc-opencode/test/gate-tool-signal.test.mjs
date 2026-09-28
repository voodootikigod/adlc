// gate-tool-signal.test.mjs — adlc_gate must never report a verdict for a gate
// child that did not exit on its own.
//
// spawnSync reports a child killed by a signal as `{ status: null, signal }`
// with no `error`, and its own timeout as `{ status: null, error: ETIMEDOUT }`.
// Neither carries an exit code, so neither may be rendered as `exit 0` (a pass)
// or as any other exit code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { runGate } from '../lib/gate-tool.mjs';

const stub = (result) => { const calls = []; const fn = (bin, args, opts) => { calls.push({ bin, args, opts }); return result; }; fn.calls = calls; return fn; };

test('a signal-killed gate is a "did not complete" error, never exit 0', () => {
  const r = runGate({ gate: 'preflight', spawnImpl: stub({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }) });
  assert.equal(r.metadata.exitCode, null);
  assert.equal(r.metadata.error, 'killed');
  assert.doesNotMatch(r.title, /exit 0/);
  assert.match(r.title, /did not complete/);
  assert.match(r.output, /SIGKILL/);
});

test('a gate that hit the spawn timeout is a "did not complete" error with no exit code', () => {
  const err = Object.assign(new Error('spawnSync adlc ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const r = runGate({ gate: 'rails-guard', spawnImpl: stub({ status: null, signal: 'SIGKILL', error: err, stdout: '' }) });
  assert.equal(r.metadata.exitCode, null);
  assert.equal(r.metadata.error, 'timed-out');
  assert.match(r.title, /did not complete/);
});

test('a missing adlc binary (ENOENT) is spawn-failed with the install hint', () => {
  const err = Object.assign(new Error('spawnSync adlc ENOENT'), { code: 'ENOENT' });
  const r = runGate({ gate: 'preflight', spawnImpl: stub({ status: null, error: err }) });
  assert.equal(r.metadata.exitCode, null);
  assert.equal(r.metadata.error, 'spawn-failed');
  assert.match(r.output, /npm i -g @adlc\/cli/);
});

test('a result with neither a status nor a signal is still not a pass', () => {
  const r = runGate({ gate: 'preflight', spawnImpl: stub({ stdout: '' }) });
  assert.equal(r.metadata.exitCode, null);
  assert.notEqual(r.metadata.error, undefined);
});

test('real exit codes are unchanged: 0 passes, 2 fails', () => {
  assert.equal(runGate({ gate: 'preflight', spawnImpl: stub({ status: 0, stdout: 'ok' }) }).metadata.exitCode, 0);
  const failed = runGate({ gate: 'preflight', spawnImpl: stub({ status: 2, stdout: '', stderr: 'x' }) });
  assert.equal(failed.metadata.exitCode, 2);
  assert.equal(failed.metadata.error, undefined);
});

test('the gate spawn is bounded and killed with SIGKILL, which a gate cannot ignore', () => {
  const spawnImpl = stub({ status: 0, stdout: 'ok' });
  runGate({ gate: 'preflight', spawnImpl });
  const { opts } = spawnImpl.calls[0];
  assert.ok(Number.isInteger(opts.timeout) && opts.timeout > 0);
  assert.equal(opts.killSignal, 'SIGKILL');
});

test('a real child killed by a signal mid-run is reported as killed (real spawnSync)', { timeout: 30_000 }, (t) => {
  const dir = tmp(t, 'oc-gate-sig-');
  const bin = join(dir, 'selfkill');
  writeFileSync(bin, '#!/bin/sh\nkill -9 $$\n');
  chmodSync(bin, 0o755);
  const r = runGate({ gate: 'preflight', spawnImpl: (_b, _a, opts) => spawnSync(bin, [], opts) });
  assert.equal(r.metadata.exitCode, null);
  assert.equal(r.metadata.error, 'killed');
});
