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
  test('rejects duplicate METHOD/path entries (compare would silently keep only the last)', () => {
    const dir = tmpDir();
    const file = join(dir, 'dup.json');
    writeFileSync(file, JSON.stringify({ routes: [
      { method: 'POST', path: '/items', status: 400 },
      { method: 'GET', path: '/items', status: 200 },
      { method: 'POST', path: '/items', status: 201 },
    ] }));
    try {
      assert.throws(() => loadSnapshot(file), /route at index 2 duplicates an earlier "POST \/items" entry/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('distinct METHOD/path pairs are not duplicates', () => {
    const dir = tmpDir();
    const file = join(dir, 'ok.json');
    writeFileSync(file, JSON.stringify({ routes: [
      { method: 'GET', path: '/items', status: 200 },
      { method: 'POST', path: '/items', status: 201 },
      { method: 'GET', path: '/items/1', status: 200 },
    ] }));
    try {
      assert.equal(loadSnapshot(file).routes.length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
          { method: 'GET', path: '/foo', status: 200 },
          { method: 'GET' }
        ] }, /route at index 1 lacks non-empty string path/],
      [{ routes: [{ method: 'GET', path: '/foo' }] }, /route at index 0 records no observation/],
      [{ routes: [{ method: 'GET', path: '/foo', status: '200' }] }, /route at index 0 has an invalid HTTP status/],
      [{ routes: [{ method: 'GET', path: '/foo', status: -1 }] }, /route at index 0 has an invalid HTTP status/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 0 }] }, /route at index 0 has an invalid HTTP status/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 99 }] }, /route at index 0 has an invalid HTTP status/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 600 }] }, /route at index 0 has an invalid HTTP status/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 200.5 }] }, /route at index 0 has an invalid HTTP status/],
      [{ routes: [{ method: 'GET', path: '/foo', status: null }] }, /route at index 0 has an invalid HTTP status/],
      [{ routes: [{ method: 'GET', path: '/foo', error: '' }] }, /route at index 0 records no observation/],
      [{ routes: [{ method: 'GET', path: '/foo', error: 42 }] }, /route at index 0 has a non-string error/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 200, error: 'boom' }] }, /route at index 0 records both an error and a status/],
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

  test('accepts an error-only (unreachable) observation', () => {
    const dir = tmpDir();
    const file = join(dir, 'err.json');
    const data = { routes: [{ method: 'GET', path: '/down', error: 'ECONNREFUSED' }] };
    writeFileSync(file, JSON.stringify(data));
    try {
      assert.deepEqual(loadSnapshot(file), data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts valid routes and parses correctly', () => {
    const dir = tmpDir();
    const file = join(dir, 'valid.json');
    const data = { routes: [{ method: 'GET', path: '/hello', status: 200 }] };
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
  test('exits 1 when both sides hold the same impossible status (-1) instead of reporting identical', () => {
    const dir = tmpDir();
    const before = join(dir, 'before.json');
    const after = join(dir, 'after.json');
    const bogus = JSON.stringify({ routes: [{ method: 'GET', path: '/x', status: -1 }] });
    writeFileSync(before, bogus);
    writeFileSync(after, bogus);
    try {
      let threw = false;
      try {
        execFileSync(process.execPath, [cliPath, 'compare', before, after], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        threw = true;
        assert.equal(err.status, 1, 'Process should exit with code 1');
        assert.match(err.stderr, /invalid HTTP status/);
      }
      assert.ok(threw, 'two impossible statuses must not compare as identical (exit 0)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('exits 1 when both sides hold the same NON-observation (no status, no error) instead of reporting identical', () => {
    const dir = tmpDir();
    const before = join(dir, 'before.json');
    const after = join(dir, 'after.json');
    const nonObservation = JSON.stringify({ routes: [{ method: 'GET', path: '/x' }] });
    writeFileSync(before, nonObservation);
    writeFileSync(after, nonObservation);
    try {
      let threw = false;
      try {
        execFileSync(process.execPath, [cliPath, 'compare', before, after], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        threw = true;
        assert.equal(err.status, 1, 'Process should exit with code 1');
        assert.match(err.stderr, /records no observation/);
      }
      assert.ok(threw, 'two non-observations must not compare as identical (exit 0)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('exits 1 on empty before snapshot', () => {
    const dir = tmpDir();
    const emptyFile = join(dir, 'empty.json');
    const validFile = join(dir, 'valid.json');

    writeFileSync(emptyFile, JSON.stringify({ routes: [] }));
    writeFileSync(validFile, JSON.stringify({ routes: [{ method: 'GET', path: '/foo', status: 200 }] }));

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
    writeFileSync(validFile, JSON.stringify({ routes: [{ method: 'GET', path: '/foo', status: 200 }] }));

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
