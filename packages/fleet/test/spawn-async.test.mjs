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

test('does not block the event loop — a timer fires while the child runs', async () => {
  let tickedDuringChild = false;
  const t = setTimeout(() => { tickedDuringChild = true; }, 20);
  await spawnAsync('/bin/sh', ['-c', 'sleep 0.1']);
  clearTimeout(t);
  assert.equal(tickedDuringChild, true, 'the event loop kept running while the child was alive (#164)');
});
