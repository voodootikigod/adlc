import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock, writeJsonAtomic, readJson } from '../lib/store.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-prune-store-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('writeJsonAtomic writes pretty JSON with a trailing newline and no leftover tmp file', () => {
  withTempDir((dir) => {
    const path = join(dir, 'out.json');
    writeJsonAtomic(path, { a: 1 });
    const text = readFileSync(path, 'utf8');
    assert.equal(text, '{\n  "a": 1\n}\n');
    assert.equal(existsSync(`${path}.tmp.${process.pid}`), false);
  });
});

test('readJson returns the fallback when the file is absent', () => {
  withTempDir((dir) => {
    const value = readJson(join(dir, 'missing.json'), { tickets: [] });
    assert.deepEqual(value, { tickets: [] });
  });
});

test('readJson round-trips what writeJsonAtomic wrote', () => {
  withTempDir((dir) => {
    const path = join(dir, 'roundtrip.json');
    writeJsonAtomic(path, { tickets: [{ id: 'T1' }] });
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
