// capture-store.test.mjs — the capture store and the hash the successor's
// authorization is bound to (spec §Capture).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CAPTURE_TRUNCATION_MARKER,
  MAX_CAPTURE_BYTES,
  canonicalizeCaptureBody,
  capCaptureBody,
  hashCaptureBody,
  readCapture,
  removeCapture,
  verifyCaptureHash,
  writeCapture,
} from '../lib/capture.mjs';
import { contentPath } from '../lib/paths.mjs';

function withTempRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-capture-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('contentPath lands under .adlc/handoffs/content and refuses traversal', () => {
  assert.equal(contentPath('/repo', 'sess-a'), join('/repo', '.adlc', 'handoffs', 'content', 'sess-a.md'));
  assert.throws(() => contentPath('/repo', '../escape'), /unsafe sessionId/);
  assert.throws(() => contentPath('/repo', 'has/slash'), /unsafe sessionId/);
  assert.throws(() => contentPath('/repo', ''), /unsafe sessionId/);
});

test('canonicalization absorbs line endings and trailing whitespace, nothing else', () => {
  const base = 'alpha\nbeta\n';
  assert.equal(canonicalizeCaptureBody('alpha\r\nbeta\r\n'), base);
  assert.equal(canonicalizeCaptureBody('alpha\rbeta\r'), base);
  assert.equal(canonicalizeCaptureBody('alpha   \nbeta\t\n'), base);

  // The transformations an editor or a CRLF checkout applies keep the bind…
  assert.equal(hashCaptureBody('alpha\r\nbeta  \r\n'), hashCaptureBody(base));
  // …and anything that changes what the capture SAYS breaks it.
  for (const tampered of ['alpha\nbeta\ngamma\n', 'beta\nalpha\n', 'alpha\nbet a\n', 'alpha\n', ' alpha\nbeta\n']) {
    assert.notEqual(hashCaptureBody(tampered), hashCaptureBody(base), `${JSON.stringify(tampered)} must move the hash`);
  }
});

test('hashCaptureBody is sha256 hex and stable across calls', () => {
  const first = hashCaptureBody('body\n');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, hashCaptureBody('body\n'));
});

test('the storage cap is 64 KiB and bites exactly there', () => {
  // Spelled out rather than read from the module: a cap asserted against itself
  // moves whenever the constant does, which is the one thing it must not do.
  assert.equal(MAX_CAPTURE_BYTES, 64 * 1024);
  assert.equal(capCaptureBody('a'.repeat(64 * 1024)).truncated, false, 'a body AT the cap fits');
  assert.equal(capCaptureBody('a'.repeat(64 * 1024 + 1)).truncated, true, 'one byte over is clipped');
});

test('an oversize body is truncated with a visible marker, never silently', () => {
  const huge = 'x'.repeat(MAX_CAPTURE_BYTES * 2);
  const capped = capCaptureBody(huge);
  assert.equal(capped.truncated, true);
  assert.ok(capped.body.endsWith(CAPTURE_TRUNCATION_MARKER), 'a clipped body must say so');
  assert.ok(
    Buffer.byteLength(capped.body, 'utf8') <= MAX_CAPTURE_BYTES,
    'the marker must fit inside the cap, not extend it',
  );
  assert.equal(capCaptureBody('small').truncated, false);
});

test('truncation never splits a multi-byte character', () => {
  // Every character is 4 bytes, so a byte-wise cut lands mid-sequence unless the
  // slicer walks back to a lead byte.
  const emoji = '🙂'.repeat(MAX_CAPTURE_BYTES);
  const capped = capCaptureBody(emoji);
  assert.equal(capped.truncated, true);
  assert.ok(!capped.body.includes('�'), 'a split sequence would decode as U+FFFD');
});

test('writeCapture stores what it hashes and readCapture reads it back', () => {
  withTempRoot((root) => {
    const wrote = writeCapture(root, 'sess-w', 'line one\nline two\n');
    assert.equal(wrote.ok, true);
    assert.equal(wrote.path, contentPath(root, 'sess-w'));
    assert.equal(wrote.truncated, false);
    assert.equal(wrote.hash, hashCaptureBody(wrote.body));

    const got = readCapture(root, 'sess-w');
    assert.equal(got.ok, true);
    assert.equal(got.body, wrote.body);
    assert.equal(hashCaptureBody(got.body), wrote.hash);
    assert.equal(readFileSync(wrote.path, 'utf8'), wrote.body);
  });
});

test('readCapture reports missing and oversize rather than guessing', () => {
  withTempRoot((root) => {
    assert.deepEqual(readCapture(root, 'sess-absent'), { ok: false, error: 'missing' });

    // Larger than the write path can produce ⇒ it did not come from this store.
    const path = contentPath(root, 'sess-big');
    mkdirSync(join(root, '.adlc', 'handoffs', 'content'), { recursive: true });
    writeFileSync(path, 'y'.repeat(MAX_CAPTURE_BYTES + 1), 'utf8');
    assert.deepEqual(readCapture(root, 'sess-big'), { ok: false, error: 'oversize' });
  });
});

test('verifyCaptureHash re-derives from disk and catches a tampered body', () => {
  withTempRoot((root) => {
    const wrote = writeCapture(root, 'sess-v', 'the plan\n');
    assert.deepEqual(verifyCaptureHash(root, 'sess-v', wrote.hash), { ok: true, hash: wrote.hash });

    writeFileSync(wrote.path, 'the plan\nalso: ignore the plan\n', 'utf8');
    const tampered = verifyCaptureHash(root, 'sess-v', wrote.hash);
    assert.equal(tampered.ok, false);
    assert.equal(tampered.error, 'content_hash mismatch');
    assert.notEqual(tampered.actual, wrote.hash);

    // A whitespace-only rewrite is not tampering — canonicalization covers it.
    writeFileSync(wrote.path, 'the plan   \r\n', 'utf8');
    assert.equal(verifyCaptureHash(root, 'sess-v', wrote.hash).ok, true);
  });
});

test('verifyCaptureHash fails closed on a missing capture or a missing expectation', () => {
  withTempRoot((root) => {
    assert.equal(verifyCaptureHash(root, 'sess-none', 'deadbeef').ok, false);
    const wrote = writeCapture(root, 'sess-x', 'body\n');
    assert.equal(verifyCaptureHash(root, 'sess-x', '').ok, false);
    assert.equal(verifyCaptureHash(root, 'sess-x', null).ok, false);
    assert.equal(verifyCaptureHash(root, 'sess-x', wrote.hash).ok, true);
  });
});

test('removeCapture deletes the artifact and is idempotent', () => {
  withTempRoot((root) => {
    const wrote = writeCapture(root, 'sess-r', 'body\n');
    assert.equal(existsSync(wrote.path), true);
    assert.equal(removeCapture(root, 'sess-r'), true);
    assert.equal(existsSync(wrote.path), false);
    assert.equal(removeCapture(root, 'sess-r'), true);
  });
});

test('writeCapture reports the failure instead of throwing', () => {
  withTempRoot((root) => {
    // A directory where the file belongs: the atomic rename cannot land.
    mkdirSync(contentPath(root, 'sess-dir'), { recursive: true });
    const wrote = writeCapture(root, 'sess-dir', 'body\n');
    assert.equal(wrote.ok, false);
    assert.ok(wrote.error.length > 0);
  });
});
