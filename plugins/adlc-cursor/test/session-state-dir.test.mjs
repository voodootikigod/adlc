// session-state-dir.test.mjs — where user-scoped Cursor state is allowed to live.
//
// `.adlc/` is the marker meaning "this directory is an ADLC repo". Keeping this
// plugin's session state in `~/.adlc` therefore made $HOME read as a repo to
// every ancestor walk, capturing unrelated projects below it. Host-specific
// state belongs in the host's own namespace (the convention @adlc/gemini
// follows with ~/.gemini/antigravity-cli), so it lives in ~/.cursor/adlc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveStateDir, withStateLock } from '../lib/session-state.mjs';

test('defaults to the Cursor host namespace, not ~/.adlc', () => {
  const dir = resolveStateDir({});
  assert.equal(dir, join(homedir(), '.cursor', 'adlc'));
});

test('never resolves inside ~/.adlc, for any home', () => {
  for (const home of ['/Users/someone', '/home/someone', '/tmp/fake-home']) {
    const dir = resolveStateDir({ HOME: home });
    // `homedir()` reads $HOME on POSIX, so this exercises the real resolution.
    assert.ok(
      !dir.startsWith(join(homedir(), '.adlc')),
      `state dir must never sit under ~/.adlc (got ${dir})`,
    );
  }
});

test('an explicit ADLC_CURSOR_STATE_DIR still wins', () => {
  assert.equal(resolveStateDir({ ADLC_CURSOR_STATE_DIR: '/tmp/custom-state' }), '/tmp/custom-state');
  assert.equal(resolveStateDir({ ADLC_CURSOR_STATE_DIR: '  /tmp/trimmed  ' }), '/tmp/trimmed');
});

test('a blank override falls back to the default rather than to cwd', () => {
  for (const blank of ['', '   ']) {
    assert.equal(resolveStateDir({ ADLC_CURSOR_STATE_DIR: blank }), join(homedir(), '.cursor', 'adlc'));
  }
});

test("withStateLock uses wait without running fallback busy-spin when wait is a function (#821)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-lock-"));
  try {
    const lockPath = join(dir, "state.lock");
    writeFileSync(lockPath, JSON.stringify({ owner: "other", leaseUntil: Date.now() + 60_000 }));
    const calls = [];
    const start = Date.now();
    const res = withStateLock(lockPath, () => "acquired", {
      retries: 3,
      backoffMs: 250,
      wait(buf, index, value, ms) {
        calls.push({ length: buf.length, index, value, ms });
        Atomics.wait(buf, index, value, 1);
        unlinkSync(lockPath);
      },
    });
    const elapsed = Date.now() - start;
    assert.equal(res, "acquired");
    assert.deepEqual(calls, [{ length: 1, index: 0, value: 0, ms: 250 }]);
    assert.ok(elapsed < 150, `expected no busy-spin after wait(), took ${elapsed}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withStateLock falls back to busy-spin when wait is not a function (#821)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-lock-spin-"));
  try {
    const lockPath = join(dir, "state.lock");
    const start = Date.now();
    writeFileSync(lockPath, JSON.stringify({ owner: "other", leaseUntil: start + 10 }));
    const res = withStateLock(lockPath, () => "acquired-after-spin", {
      now: start,
      retries: 3,
      backoffMs: 20,
      wait: null,
    });
    const elapsed = Date.now() - start;
    assert.equal(res, "acquired-after-spin");
    assert.ok(elapsed >= 18, `expected fallback busy-spin to wait ~20ms, took ${elapsed}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
