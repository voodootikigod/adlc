// packages/behavior-diff/test/compare.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';

import { loadSnapshot } from '../lib/compare.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, '../bin/behavior-diff.mjs');

describe('loadSnapshot validation (unit)', () => {
  test('rejects duplicate METHOD/path entries (compare would silently keep only the last)', (t) => {
    const dir = tmp(t, 'compare-test-');
    const file = join(dir, 'dup.json');
    writeFileSync(file, JSON.stringify({ routes: [
      { method: 'POST', path: '/items', status: 400, contentType: 'application/json', body: {} },
      { method: 'GET', path: '/items', status: 200, contentType: 'application/json', body: {} },
      { method: 'POST', path: '/items', status: 201, contentType: 'application/json', body: {} },
    ] }));
    assert.throws(() => loadSnapshot(file), /route at index 2 duplicates an earlier "POST \/items" entry/);
  });

  test('distinct METHOD/path pairs are not duplicates', (t) => {
    const dir = tmp(t, 'compare-test-');
    const file = join(dir, 'ok.json');
    writeFileSync(file, JSON.stringify({ routes: [
      { method: 'GET', path: '/items', status: 200, contentType: 'application/json', body: {} },
      { method: 'POST', path: '/items', status: 201, contentType: 'application/json', body: {} },
      { method: 'GET', path: '/items/1', status: 200, contentType: 'application/json', body: {} },
    ] }));
    assert.equal(loadSnapshot(file).routes.length, 3);
  });

  test('rejects empty routes array', (t) => {
    const dir = tmp(t, 'compare-test-');
    const file = join(dir, 'empty.json');
    writeFileSync(file, JSON.stringify({ routes: [] }));
    assert.throws(() => loadSnapshot(file), /has empty routes array/);
  });

  test('rejects malformed routes', (t) => {
    const dir = tmp(t, 'compare-test-');
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
          { method: 'GET', path: '/foo', status: 200, contentType: 'application/json', body: {} },
          { method: 'GET' }
        ] }, /route at index 1 lacks non-empty string path/],
      [{ routes: [{ method: 'GET', path: '/foo' }] }, /route at index 0 records no observation/],
      [{ routes: [{ method: 'GET', path: '/foo', status: '200' }] }, /route at index 0 has an invalid HTTP status/],
      [{ routes: [{ method: 'GET', path: '/foo', status: -1 }] }, /route at index 0 has an invalid HTTP status/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 0 }] }, /route at index 0 has an invalid HTTP status/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 99 }] }, /route at index 0 has an invalid HTTP status/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 600, contentType: 'application/json', body: {} }] }, /route at index 0 has an invalid HTTP status/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 200.5 }] }, /route at index 0 has an invalid HTTP status/],
      [{ routes: [{ method: 'GET', path: '/foo', status: null }] }, /route at index 0 has an invalid HTTP status/],
      [{ routes: [{ method: 'GET', path: '/foo', error: '' }] }, /route at index 0 records no observation/],
      [{ routes: [{ method: 'GET', path: '/foo', error: 42 }] }, /route at index 0 has a non-string error/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 200, error: 'boom' }] }, /route at index 0 records both an error and a status/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 200 }] }, /route at index 0 is an incomplete observation/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 200, contentType: 'text/plain' }] }, /route at index 0 is an incomplete observation/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 200, body: {} }] }, /route at index 0 is an incomplete observation/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 200, contentType: null, body: {} }] }, /route at index 0 is an incomplete observation/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 200, contentType: 'text/plain', body: {} }] }, /route at index 0 has a malformed text body/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 200, contentType: 'text/plain', body: null }] }, /route at index 0 has a malformed text body/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 200, contentType: 'text/plain', body: 'raw text' }] }, /route at index 0 has a malformed text body/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 200, contentType: 'text/plain', body: { textHash: 'abc', bytes: 3 } }] }, /route at index 0 has a malformed text body/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 200, contentType: 'text/plain', body: { textHash: 'a'.repeat(64), bytes: -1 } }] }, /route at index 0 has a malformed text body/],
      [{ routes: [{ method: 'GET', path: '/foo', status: 200, contentType: 'text/plain', body: { textHash: 'a'.repeat(64) } }] }, /route at index 0 has a malformed text body/],
    ];

    for (const [data, regex] of cases) {
      writeFileSync(file, JSON.stringify(data));
      assert.throws(() => loadSnapshot(file), regex);
    }
  });

  test('accepts a well-formed text observation ({textHash, bytes}) with a REAL digest', (t) => {
    const dir = tmp(t, 'compare-test-');
    const file = join(dir, 'text.json');
    // A genuine sha256 hex, not a synthetic run of one letter: the hash
    // alphabet is [0-9a-f] and a real digest exercises the digits too.
    const textHash = createHash('sha256').update('hello world\n', 'utf8').digest('hex');
    assert.match(textHash, /0/, 'fixture digest must contain a zero digit');
    assert.match(textHash, /[a-f]/, 'fixture digest must contain a hex letter');
    const data = { routes: [{ method: 'GET', path: '/plain', status: 200, contentType: 'text/plain; charset=utf-8', body: { textHash, bytes: 12 } }] };
    writeFileSync(file, JSON.stringify(data));
    assert.deepEqual(loadSnapshot(file), data);
  });

  test('accepts an error-only (unreachable) observation', (t) => {
    const dir = tmp(t, 'compare-test-');
    const file = join(dir, 'err.json');
    const data = { routes: [{ method: 'GET', path: '/down', error: 'ECONNREFUSED' }] };
    writeFileSync(file, JSON.stringify(data));
    assert.deepEqual(loadSnapshot(file), data);
  });

  test('accepts valid routes and parses correctly', (t) => {
    const dir = tmp(t, 'compare-test-');
    const file = join(dir, 'valid.json');
    const data = { routes: [{ method: 'GET', path: '/hello', status: 200, contentType: 'application/json', body: {} }] };
    writeFileSync(file, JSON.stringify(data));
    const snap = loadSnapshot(file);
    assert.deepEqual(snap, data);
  });
});

describe('CLI compare integration (empty/malformed rejection)', () => {
  test('exits 1 on malformed TEXT bodies instead of comparing their missing hashes as identical', (t) => {
    const dir = tmp(t, 'compare-test-');
    const before = join(dir, 'before.json');
    const after = join(dir, 'after.json');
    writeFileSync(before, JSON.stringify({ routes: [{ method: 'GET', path: '/t', status: 200, contentType: 'text/plain', body: {} }] }));
    writeFileSync(after, JSON.stringify({ routes: [{ method: 'GET', path: '/t', status: 200, contentType: 'text/plain', body: { different: true } }] }));
    let threw = false;
    try {
      execFileSync(process.execPath, [cliPath, 'compare', before, after], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1, 'Process should exit with code 1');
      assert.match(err.stderr, /malformed text body/);
    }
    assert.ok(threw, 'two hash-less text bodies must not compare as identical (exit 0)');
  });

  test('exits 1 when both sides hold the same STATUS-ONLY entry (no contentType/body) instead of reporting identical', (t) => {
    const dir = tmp(t, 'compare-test-');
    const before = join(dir, 'before.json');
    const after = join(dir, 'after.json');
    const partial = JSON.stringify({ routes: [{ method: 'GET', path: '/account', status: 200 }] });
    writeFileSync(before, partial);
    writeFileSync(after, partial);
    let threw = false;
    try {
      execFileSync(process.execPath, [cliPath, 'compare', before, after], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1, 'Process should exit with code 1');
      assert.match(err.stderr, /incomplete observation/);
    }
    assert.ok(threw, 'two status-only entries must not compare as identical (exit 0)');
  });

  test('exits 1 when both sides hold the same impossible status (-1) instead of reporting identical', (t) => {
    const dir = tmp(t, 'compare-test-');
    const before = join(dir, 'before.json');
    const after = join(dir, 'after.json');
    const bogus = JSON.stringify({ routes: [{ method: 'GET', path: '/x', status: -1 }] });
    writeFileSync(before, bogus);
    writeFileSync(after, bogus);
    let threw = false;
    try {
      execFileSync(process.execPath, [cliPath, 'compare', before, after], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1, 'Process should exit with code 1');
      assert.match(err.stderr, /invalid HTTP status/);
    }
    assert.ok(threw, 'two impossible statuses must not compare as identical (exit 0)');
  });

  test('exits 1 when both sides hold the same NON-observation (no status, no error) instead of reporting identical', (t) => {
    const dir = tmp(t, 'compare-test-');
    const before = join(dir, 'before.json');
    const after = join(dir, 'after.json');
    const nonObservation = JSON.stringify({ routes: [{ method: 'GET', path: '/x' }] });
    writeFileSync(before, nonObservation);
    writeFileSync(after, nonObservation);
    let threw = false;
    try {
      execFileSync(process.execPath, [cliPath, 'compare', before, after], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1, 'Process should exit with code 1');
      assert.match(err.stderr, /records no observation/);
    }
    assert.ok(threw, 'two non-observations must not compare as identical (exit 0)');
  });

  test('exits 1 on empty before snapshot', (t) => {
    const dir = tmp(t, 'compare-test-');
    const emptyFile = join(dir, 'empty.json');
    const validFile = join(dir, 'valid.json');

    writeFileSync(emptyFile, JSON.stringify({ routes: [] }));
    writeFileSync(validFile, JSON.stringify({ routes: [{ method: 'GET', path: '/foo', status: 200, contentType: 'application/json', body: {} }] }));

    let threw = false;
    try {
      execFileSync(process.execPath, [cliPath, 'compare', emptyFile, validFile], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1, 'Process should exit with code 1');
      assert.match(err.stderr, /has empty routes array/);
    }
    assert.ok(threw, 'Command should have failed but exited 0');
  });

  test('exits 1 on malformed after snapshot', (t) => {
    const dir = tmp(t, 'compare-test-');
    const malformed = join(dir, 'malformed.json');
    const validFile = join(dir, 'valid.json');

    writeFileSync(malformed, JSON.stringify({ routes: [{ method: 'GET' }] }));
    writeFileSync(validFile, JSON.stringify({ routes: [{ method: 'GET', path: '/foo', status: 200, contentType: 'application/json', body: {} }] }));

    let threw = false;
    try {
      execFileSync(process.execPath, [cliPath, 'compare', validFile, malformed], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1, 'Process should exit with code 1');
      assert.match(err.stderr, /lacks non-empty string path/);
    }
    assert.ok(threw, 'Command should have failed but exited 0');
  });
});
