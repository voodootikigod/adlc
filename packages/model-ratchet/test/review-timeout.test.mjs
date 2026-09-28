// Each --review-cmd run is bounded by --timeout-ms. A run that exceeds it is
// killed and recorded as an operational error for that file; the loop moves on
// and the whole run exits 1 instead of hanging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitRepo } from '@adlc/core/test-kit';
import { runReviewCmd, reviewRunError, DEFAULT_REVIEW_TIMEOUT_MS } from '../lib/run-review.mjs';

const BIN = fileURLToPath(new URL('../bin/model-ratchet.mjs', import.meta.url));

function hotRepo(t) {
  const { dir, git } = gitRepo(t, 'mr-timeout-');
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const n of [1, 2]) {
    writeFileSync(join(dir, 'src', 'a.mjs'), `export const a = ${n};\n`);
    writeFileSync(join(dir, 'src', 'b.mjs'), `export const b = ${n};\n`);
    git('add', '.');
    git('commit', '-m', `c${n}`);
  }
  return dir;
}

function run(dir, args) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', timeout: 30000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, elapsed: Date.now() - started };
}

test('runReviewCmd kills a command that outlives timeoutMs and reports timedOut', () => {
  const started = Date.now();
  const result = runReviewCmd('sleep 30', 'x.mjs', undefined, { timeoutMs: 300 });
  assert.ok(Date.now() - started < 10000, 'the call must return near the timeout, not after the command');
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.notEqual(result.exitCode, 2);
});

test('runReviewCmd within the bound is not timed out', () => {
  const result = runReviewCmd('node -e process.exit(2)', 'x.mjs', undefined, { timeoutMs: 20000 });
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 2);
});

test('a non-timeout signal kill is reported with its signal', () => {
  const result = runReviewCmd('node -e process.kill(process.pid,15)', 'x.mjs', undefined, { timeoutMs: 20000 });
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, 'SIGTERM');
  assert.notEqual(result.exitCode, 0);
});

test('the default bound is ten minutes', () => {
  assert.equal(DEFAULT_REVIEW_TIMEOUT_MS, 600000);
});

test('--timeout-ms: every hung review is a per-file error and the run exits 1', (t) => {
  const dir = hotRepo(t);
  const res = run(dir, ['--review-cmd', 'sleep 30', '--timeout-ms', '300', '--json']);
  assert.equal(res.code, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.ok(res.elapsed < 20000, `run took ${res.elapsed}ms`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.operationalError, true);
  assert.equal(out.results.length, 2, 'the loop continues past the first timed-out file');
  for (const r of out.results) assert.equal(r.error, 'review-cmd timed out after 300ms');
});

test('human mode reports the timeout and exits 1', (t) => {
  const dir = hotRepo(t);
  const res = run(dir, ['--review-cmd', 'sleep 30', '--timeout-ms', '300']);
  assert.equal(res.code, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stdout + res.stderr, /timed out after 300ms/);
});

for (const bad of ['0', '-1', 'abc', '1e3', '10x', '']) {
  test(`--timeout-ms ${JSON.stringify(bad)} is refused with exit 1`, (t) => {
    const dir = hotRepo(t);
    const res = run(dir, ['--review-cmd', 'true', `--timeout-ms=${bad}`]);
    assert.equal(res.code, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stderr, /--timeout-ms must be a positive integer/);
  });
}

test('a review that finishes inside --timeout-ms succeeds', (t) => {
  const dir = hotRepo(t);
  const res = run(dir, ['--review-cmd', 'true', '--timeout-ms', '20000', '--json']);
  assert.equal(res.code, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.equal(JSON.parse(res.stdout).operationalError, false);
});

test('reviewRunError classifies each way a run can end', () => {
  const ok = { timedOut: false, signal: null };
  assert.equal(reviewRunError({ ...ok, exitCode: 0 }, 5), null);
  assert.equal(reviewRunError({ ...ok, exitCode: 2 }, 5), null);
  assert.equal(reviewRunError({ ...ok, exitCode: 1 }, 5), 'review-cmd exited with code 1');
  assert.equal(reviewRunError({ ...ok, exitCode: 3 }, 5), 'review-cmd exited with code 3');
  assert.equal(reviewRunError({ exitCode: 1, timedOut: false, signal: 'SIGTERM' }, 5), 'review-cmd was killed by SIGTERM');
  assert.equal(reviewRunError({ exitCode: 1, timedOut: true, signal: 'SIGKILL' }, 5), 'review-cmd timed out after 5ms');
});

test('an empty review command is not reported as timed out', () => {
  assert.deepEqual(runReviewCmd('   ', 'x.mjs'), { stdout: '', stderr: 'empty review command', exitCode: 1, timedOut: false, signal: null });
});
