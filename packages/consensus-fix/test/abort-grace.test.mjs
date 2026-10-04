// abort-grace.test.mjs — an aborted command gets SIGTERM and ABORT_GRACE_MS to
// clean up before SIGKILL, and is killed regardless once the grace runs out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { runCommand, ABORT_GRACE_MS } from '../lib/runner.mjs';

/** Abort `cmd` once it has had `afterMs` to install its traps. */
function abortAfter(cmd, afterMs) {
  const controller = new AbortController();
  const pending = runCommand(cmd, { signal: controller.signal });
  setTimeout(() => controller.abort(), afterMs);
  return pending;
}

test('a command that cleans up on SIGTERM is given the grace period to finish', async (t) => {
  const marker = join(tmp(t, 'consensus-fix-grace-'), 'cleaned-up');
  const cmd = `trap 'sleep 0.3; touch "${marker}"; exit 0' TERM; while :; do sleep 0.05; done`;
  const result = await abortAfter(cmd, 200);
  assert.equal(result.exitCode, 130);
  assert.equal(existsSync(marker), true, 'SIGKILL arrived before the SIGTERM cleanup could finish');
});

test('a command that ignores SIGTERM is killed once the grace period runs out', async () => {
  const started = Date.now();
  const result = await abortAfter("trap '' TERM; while :; do sleep 0.05; done", 200);
  const elapsed = Date.now() - started;
  assert.equal(result.exitCode, 130);
  assert.ok(elapsed >= ABORT_GRACE_MS, `killed after ${elapsed} ms, before the ${ABORT_GRACE_MS} ms grace`);
  assert.ok(elapsed < ABORT_GRACE_MS + 3000, `still running ${elapsed} ms after abort`);
});
