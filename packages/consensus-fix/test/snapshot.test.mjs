/**
 * Tests for snapshot/restore logic using tmp directories.
 * No network, cleaned up after each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, symlinkSync, lstatSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { writeInflightAtomic } from '@adlc/core';
import { takeSnapshot, restoreSnapshot, applyChanges, writeFileAtomic } from '../lib/snapshot.mjs';

test('takeSnapshot captures current file contents', (t) => {
  const dir = tmp(t, 'consensus-fix-test-');
  const f1 = join(dir, 'a.mjs');
  const f2 = join(dir, 'b.mjs');
  writeFileSync(f1, 'content A');
  writeFileSync(f2, 'content B');

  const snap = takeSnapshot([f1, f2]);
  assert.equal(snap[f1], 'content A');
  assert.equal(snap[f2], 'content B');
});

test('restoreSnapshot writes original content back', (t) => {
  const dir = tmp(t, 'consensus-fix-test-');
  const f1 = join(dir, 'a.mjs');
  writeFileSync(f1, 'original');

  const snap = takeSnapshot([f1]);

  // Mutate the file.
  writeFileSync(f1, 'mutated content');
  assert.equal(readFileSync(f1, 'utf8'), 'mutated content');

  restoreSnapshot(snap);
  assert.equal(readFileSync(f1, 'utf8'), 'original');
});

test('restoreSnapshot handles multiple files', (t) => {
  const dir = tmp(t, 'consensus-fix-test-');
  const files = ['a.mjs', 'b.mjs', 'c.mjs'].map((n) => join(dir, n));
  const originals = ['AAA', 'BBB', 'CCC'];
  files.forEach((f, i) => writeFileSync(f, originals[i]));

  const snap = takeSnapshot(files);

  // Mutate all.
  files.forEach((f) => writeFileSync(f, 'MUTATED'));

  restoreSnapshot(snap);

  files.forEach((f, i) => {
    assert.equal(readFileSync(f, 'utf8'), originals[i]);
  });
});

test('applyChanges applies a hunk and writes only files in snapshot', (t) => {
  const dir = tmp(t, 'consensus-fix-test-');
  const f1 = join(dir, 'a.mjs');
  writeFileSync(f1, 'original');
  const snap = { [f1]: 'original' };

  const changes = [{ file: f1, hunks: [{ startLine: 1, endLine: 1, replacement: 'updated' }] }];
  const result = applyChanges(changes, snap);

  assert.equal(result.ok, true);
  assert.equal(readFileSync(f1, 'utf8'), 'updated');
});

test('applyChanges returns ok:false (does not throw) when a hunk fails to apply cleanly', (t) => {
  const dir = tmp(t, 'consensus-fix-test-');
  const f1 = join(dir, 'a.mjs');
  writeFileSync(f1, 'one line only');
  const snap = { [f1]: 'one line only' };

  // endLine 5 is out of bounds for a 1-line file.
  const changes = [{ file: f1, hunks: [{ startLine: 1, endLine: 5, replacement: 'x' }] }];
  const result = applyChanges(changes, snap);

  assert.equal(result.ok, false);
  assert.match(result.error, /exceeds file length/);
  // The original file must be untouched — apply failed before any write.
  assert.equal(readFileSync(f1, 'utf8'), 'one line only');
});

test('applyChanges throws when file not in snapshot', (t) => {
  const dir = tmp(t, 'consensus-fix-test-');
  const f1 = join(dir, 'a.mjs');
  writeFileSync(f1, 'original');
  const snap = { [f1]: 'original' };

  const outsideFile = join(dir, 'outside.mjs');
  const changes = [{ file: outsideFile, hunks: [{ startLine: 1, endLine: 1, replacement: 'injected' }] }];

  assert.throws(
    () => applyChanges(changes, snap),
    /not in provided list/
  );
});

test('snapshot round-trip: take → mutate → restore is stable', (t) => {
  const dir = tmp(t, 'consensus-fix-test-');
  const f1 = join(dir, 'file.mjs');
  const original = 'export const x = 1;\nexport const y = 2;\n';
  writeFileSync(f1, original);

  const snap = takeSnapshot([f1]);
  writeFileSync(f1, 'completely different content\n');
  restoreSnapshot(snap);

  assert.equal(readFileSync(f1, 'utf8'), original);
});

test('re-exported writeFileAtomic matches @adlc/core writeInflightAtomic', () => {
  assert.equal(writeFileAtomic, writeInflightAtomic);
});

test('writeFileAtomic and restoreSnapshot preserve symlinks and write through them', (t) => {
  const dir = tmp(t, 'consensus-symlink-test-');
  const realFile = join(dir, 'real.mjs');
  const symlinkFile = join(dir, 'link.mjs');

  writeFileSync(realFile, 'real content');
  symlinkSync(realFile, symlinkFile);

  assert.equal(lstatSync(symlinkFile).isSymbolicLink(), true);

  // writeFileAtomic writes through symlink and preserves link
  writeFileAtomic(symlinkFile, 'updated via atomic');
  assert.equal(lstatSync(symlinkFile).isSymbolicLink(), true, 'writeFileAtomic preserved symlink');
  assert.equal(readFileSync(realFile, 'utf8'), 'updated via atomic');
  assert.equal(readFileSync(symlinkFile, 'utf8'), 'updated via atomic');

  // restoreSnapshot preserves symlink and restores target
  const snap = takeSnapshot([symlinkFile]);
  writeFileSync(realFile, 'corrupted');
  assert.equal(readFileSync(symlinkFile, 'utf8'), 'corrupted');

  restoreSnapshot(snap);
  assert.equal(lstatSync(symlinkFile).isSymbolicLink(), true, 'restoreSnapshot preserved symlink');
  assert.equal(readFileSync(realFile, 'utf8'), 'updated via atomic');
  assert.equal(readFileSync(symlinkFile, 'utf8'), 'updated via atomic');
});

test('writeFileAtomic and restoreSnapshot preserve file modes', (t) => {
  const dir = tmp(t, 'consensus-mode-test-');
  const execFile = join(dir, 'script.sh');

  writeFileSync(execFile, '#!/bin/sh\necho hi\n');
  chmodSync(execFile, 0o755);
  assert.equal(statSync(execFile).mode & 0o777, 0o755);

  // writeFileAtomic preserves mode
  writeFileAtomic(execFile, '#!/bin/sh\necho updated\n');
  assert.equal(statSync(execFile).mode & 0o777, 0o755, 'writeFileAtomic preserved 0755 mode');
  assert.equal(readFileSync(execFile, 'utf8'), '#!/bin/sh\necho updated\n');

  // restoreSnapshot preserves mode
  const snap = takeSnapshot([execFile]);
  writeFileSync(execFile, 'mutated content');
  assert.equal(statSync(execFile).mode & 0o777, 0o755);

  restoreSnapshot(snap);
  assert.equal(statSync(execFile).mode & 0o777, 0o755, 'restoreSnapshot preserved 0755 mode');
  assert.equal(readFileSync(execFile, 'utf8'), '#!/bin/sh\necho updated\n');
});
