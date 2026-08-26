// packages/behavior-diff/test/compare.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadSnapshot } from '../lib/compare.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, '../bin/behavior-diff.mjs');

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'compare-test-'));
}

describe('loadSnapshot validation (unit)', () => {
  test('rejects empty routes array', () => {
    const dir = tmpDir();
    const file = join(dir, 'empty.json');
    writeFileSync(file, JSON.stringify({ routes: [] }));

    try {
      assert.throws(() => loadSnapshot(file), /has empty routes array/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects malformed routes', () => {
    const dir = tmpDir();
    const file = join(dir, 'malformed.json');

    const cases = [
      [{ routes: ['not an object'] }, /route at index 0 is not an object/],
      [{ routes: [{}] }, /route at index 0 lacks non-empty string method/],
      [{ routes: [{ method: '' }] }, /route at index 0 lacks non-empty string method/],
      [{ routes: [{ method: 123 }] }, /route at index 0 lacks non-empty string method/],
      [{ routes: [{ method: 'GET' }] }, /route at index 0 lacks non-empty string path/],
      [{ routes: [{ method: 'GET', path: '' }] }, /route at index 0 lacks non-empty string path/],
      [{ routes: [{ method: 'GET', path: 123 }] }, /route at index 0 lacks non-empty string path/],
      [{ routes: [
          { method: 'GET', path: '/foo' },
          { method: 'GET' }
        ] }, /route at index 1 lacks non-empty string path/],
    ];

    try {
      for (const [data, regex] of cases) {
        writeFileSync(file, JSON.stringify(data));
        assert.throws(() => loadSnapshot(file), regex);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts valid routes and parses correctly', () => {
    const dir = tmpDir();
    const file = join(dir, 'valid.json');
    const data = { routes: [{ method: 'GET', path: '/hello' }] };
    writeFileSync(file, JSON.stringify(data));

    try {
      const snap = loadSnapshot(file);
      assert.deepEqual(snap, data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI compare integration (empty/malformed rejection)', () => {
  test('exits 1 on empty before snapshot', () => {
    const dir = tmpDir();
    const emptyFile = join(dir, 'empty.json');
    const validFile = join(dir, 'valid.json');

    writeFileSync(emptyFile, JSON.stringify({ routes: [] }));
    writeFileSync(validFile, JSON.stringify({ routes: [{ method: 'GET', path: '/foo' }] }));

    try {
      let threw = false;
      try {
        execFileSync(process.execPath, [cliPath, 'compare', emptyFile, validFile], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        threw = true;
        assert.equal(err.status, 1, 'Process should exit with code 1');
        assert.match(err.stderr, /has empty routes array/);
      }
      assert.ok(threw, 'Command should have failed but exited 0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('exits 1 on malformed after snapshot', () => {
    const dir = tmpDir();
    const malformed = join(dir, 'malformed.json');
    const validFile = join(dir, 'valid.json');

    writeFileSync(malformed, JSON.stringify({ routes: [{ method: 'GET' }] }));
    writeFileSync(validFile, JSON.stringify({ routes: [{ method: 'GET', path: '/foo' }] }));

    try {
      let threw = false;
      try {
        execFileSync(process.execPath, [cliPath, 'compare', validFile, malformed], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        threw = true;
        assert.equal(err.status, 1, 'Process should exit with code 1');
        assert.match(err.stderr, /lacks non-empty string path/);
      }
      assert.ok(threw, 'Command should have failed but exited 0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
