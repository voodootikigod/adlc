import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnAsync } from '../lib/spawn-async.mjs';

test('captures stdout and a zero exit', async () => {
  const r = await spawnAsync('/bin/sh', ['-c', 'echo hello-fleet']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hello-fleet/);
  assert.equal(r.timedOut, false);
});

test('propagates a non-zero exit status and stderr', async () => {
  const r = await spawnAsync('/bin/sh', ['-c', 'echo oops 1>&2; exit 3']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /oops/);
});

test('a missing binary resolves to an error result (not a throw)', async () => {
  const r = await spawnAsync('/definitely/not/a/real/binary-xyz', []);
  assert.ok(r.error, 'spawn error is surfaced as { error }');
  assert.equal(r.status, null);
});

test('a command exceeding the timeout is killed and flagged timedOut', async () => {
  const r = await spawnAsync('/bin/sh', ['-c', 'sleep 5'], { timeout: 50 });
  assert.equal(r.timedOut, true, 'the slow command was killed by the timeout');
  assert.notEqual(r.status, 0);
});

test('opts.input is piped to the child stdin (agy-style prompt)', async () => {
  // `cat` echoes stdin to stdout — proves the input actually reached the child.
  const r = await spawnAsync('cat', [], { input: 'prompt-on-stdin-123' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /prompt-on-stdin-123/);
});

test('without opts.input the child gets no stdin (reads EOF immediately)', async () => {
  // `cat` with stdin ignored closes immediately with empty output.
  const r = await spawnAsync('cat', [], {});
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('does not block the event loop — a timer fires while the child runs', async () => {
  let tickedDuringChild = false;
  const t = setTimeout(() => { tickedDuringChild = true; }, 20);
  await spawnAsync('/bin/sh', ['-c', 'sleep 0.1']);
  clearTimeout(t);
  assert.equal(tickedDuringChild, true, 'the event loop kept running while the child was alive (#164)');
});

test('output accumulation is BOUNDED: past maxOutputBytes the rest is dropped (truncated:true), the child still runs to completion, and the default cap is generous', async () => {
  const r = await spawnAsync('/bin/sh', ['-c', 'head -c 300000 /dev/zero | tr "\\0" x; echo; echo done-on-stderr 1>&2'], { maxOutputBytes: 1000 });
  assert.equal(r.status, 0, 'the child is never blocked or killed by the cap');
  assert.equal(r.stdout.length, 1000, 'stdout is cut at the cap');
  assert.equal(r.truncated, true);
  assert.equal(r.stderr, 'done-on-stderr\n', 'the other stream is intact (it stayed under the cap)');
  const small = await spawnAsync('/bin/sh', ['-c', 'head -c 20000 /dev/zero | tr "\\0" y']);
  assert.equal(small.stdout.length, 20000); assert.equal(small.truncated, false, 'the default cap does not touch ordinary output');
  const { DEFAULT_MAX_OUTPUT_BYTES } = await import('../lib/spawn-async.mjs');
  assert.ok(DEFAULT_MAX_OUTPUT_BYTES >= 8 * 1024 * 1024, 'the default is a memory guard, not a transcript limit');
});

test('maxOutputBytes is a BYTE budget: multibyte output is cut by bytes, never by UTF-16 units', async () => {
  // 'é' is 2 bytes / 1 unit: 4000 of them = 8000 bytes; a 1000-BYTE cap keeps ≤ 1000 bytes (500 chars), not 1000 chars (2000 bytes).
  const r = await spawnAsync(process.execPath, ['-e', 'process.stdout.write("\u00e9".repeat(4000))'], { maxOutputBytes: 1000 });
  assert.equal(r.status, 0);
  assert.ok(Buffer.byteLength(r.stdout, 'utf8') <= 1000, `bytes kept: ${Buffer.byteLength(r.stdout, 'utf8')}`);
  assert.equal(r.truncated, true);
  const whole = await spawnAsync(process.execPath, ['-e', 'process.stdout.write("\u00e9".repeat(100))']);
  assert.equal(whole.stdout, '\u00e9'.repeat(100), 'a chunk boundary inside a multibyte sequence never corrupts the decoded text');
  assert.equal(whole.truncated, false);
});
