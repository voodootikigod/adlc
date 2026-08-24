import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { acquireLock, releaseLock, stageJsonAtomic, readJson } from '../lib/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_MJS_URL = new URL('../lib/store.mjs', import.meta.url).href;

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-prune-store-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Hold the lock at `dir` in a separate process for `holdMs`, then release it.
 * acquireLock's retry loop uses a synchronous, event-loop-blocking sleep
 * (Atomics.wait), so a same-process timer cannot release the lock while this
 * test's own acquireLock call is retrying — hence a real child process.
 * Returns a promise that resolves once the child has acquired the lock (so
 * the caller's subsequent acquireLock call is guaranteed to contend with it).
 */
function holdLockInChildThenRelease(dir, holdMs) {
  return new Promise((resolvePromise, reject) => {
    const script = `
      import { acquireLock, releaseLock } from '${STORE_MJS_URL}';
      const dir = process.argv[1];
      const holdMs = Number(process.argv[2]);
      const got = acquireLock(dir, { retries: 0, delayMs: 0 });
      if (!got) { console.error('child could not acquire lock'); process.exit(1); }
      console.log('LOCKED');
      setTimeout(() => { releaseLock(dir); }, holdMs);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, '--', dir, String(holdMs)], {
      cwd: HERE,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let settled = false;
    child.stdout.on('data', (chunk) => {
      if (!settled && chunk.toString('utf8').includes('LOCKED')) {
        settled = true;
        resolvePromise(child);
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!settled) reject(new Error(`child exited (${code}) before acquiring the lock`));
    });
  });
}

test('stageJsonAtomic writes pretty JSON with a trailing newline and no leftover tmp file', () => {
  withTempDir((dir) => {
    const path = join(dir, 'out.json');
    stageJsonAtomic(path, { a: 1 }).commit();
    const text = readFileSync(path, 'utf8');
    assert.equal(text, '{\n  "a": 1\n}\n');
    assert.equal(existsSync(`${path}.tmp.${process.pid}`), false);
  });
});

test('a staged write is INVISIBLE until it is committed, and discard leaves nothing behind', () => {
  withTempDir((dir) => {
    const path = join(dir, 'staged.json');
    const staged = stageJsonAtomic(path, { a: 1 });
    // The whole point of the split: a caller can do something fallible here and
    // still decide not to publish the change.
    assert.equal(existsSync(path), false, 'nothing is visible at the target yet');
    assert.equal(existsSync(`${path}.tmp.${process.pid}`), true, 'but the content is on disk');
    staged.discard();
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(`${path}.tmp.${process.pid}`), false, 'discard cleans up the staged copy');
  });
});

test('readJson returns the fallback when the file is absent', () => {
  withTempDir((dir) => {
    const value = readJson(join(dir, 'missing.json'), { tickets: [] });
    assert.deepEqual(value, { tickets: [] });
  });
});

test('readJson round-trips what stageJsonAtomic committed', () => {
  withTempDir((dir) => {
    const path = join(dir, 'roundtrip.json');
    stageJsonAtomic(path, { tickets: [{ id: 'T1' }] }).commit();
    assert.deepEqual(readJson(path, null), { tickets: [{ id: 'T1' }] });
  });
});

test('readJson throws a clear error on invalid JSON (not silently swallowed)', () => {
  withTempDir((dir) => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{ not valid json');
    assert.throws(() => readJson(path, null), /invalid JSON/);
  });
});

test('acquireLock/releaseLock: second acquirer blocks until release, then can acquire', () => {
  withTempDir((dir) => {
    const gotFirst = acquireLock(dir, { retries: 0, delayMs: 0 });
    assert.equal(gotFirst, true);

    // A second attempt with zero retries must fail fast (lock held).
    const gotSecond = acquireLock(dir, { retries: 0, delayMs: 0 });
    assert.equal(gotSecond, false);

    releaseLock(dir);

    const gotThird = acquireLock(dir, { retries: 0, delayMs: 0 });
    assert.equal(gotThird, true);
    releaseLock(dir);
  });
});

test('acquireLock retry/backoff loop actually waits out a held lock instead of failing fast', async () => {
  // Not withTempDir: that helper's `finally` runs rmSync synchronously right
  // after invoking the callback, which would delete the dir out from under
  // this async test before the awaited work below finishes.
  const dir = mkdtempSync(join(tmpdir(), 'ticket-prune-store-'));
  try {
    const HOLD_MS = 150;
    const child = await holdLockInChildThenRelease(dir, HOLD_MS);
    try {
      // Give the held lock time to still be held, then acquire with a real
      // retry/backoff budget (small per-retry delay, enough retries to
      // outlast HOLD_MS) — this only succeeds if the loop actually retries.
      const start = Date.now();
      const got = acquireLock(dir, { retries: 50, delayMs: 10 });
      const elapsedMs = Date.now() - start;

      assert.equal(got, true, 'acquireLock should eventually succeed once the child releases');
      // A fail-fast (single-attempt) implementation would return well before
      // the child releases; a real retry loop must take at least roughly as
      // long as the lock was held.
      assert.ok(
        elapsedMs >= HOLD_MS * 0.5,
        `expected acquireLock to block for close to ${HOLD_MS}ms while retrying, only took ${elapsedMs}ms`,
      );
      releaseLock(dir);
    } finally {
      await new Promise((res) => child.on('exit', res));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
