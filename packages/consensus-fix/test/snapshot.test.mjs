/**
 * Tests for snapshot/restore logic using tmp directories.
 * No network, cleaned up after each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { takeSnapshot, restoreSnapshot, applyChanges } from '../lib/snapshot.mjs';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'consensus-fix-test-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('takeSnapshot captures current file contents', () => {
  const dir = makeTmp();
  try {
    const f1 = join(dir, 'a.mjs');
    const f2 = join(dir, 'b.mjs');
    writeFileSync(f1, 'content A');
    writeFileSync(f2, 'content B');

    const snap = takeSnapshot([f1, f2]);
    assert.equal(snap[f1], 'content A');
    assert.equal(snap[f2], 'content B');
  } finally {
    cleanup(dir);
  }
});

test('restoreSnapshot writes original content back', () => {
  const dir = makeTmp();
  try {
    const f1 = join(dir, 'a.mjs');
    writeFileSync(f1, 'original');

    const snap = takeSnapshot([f1]);

    // Mutate the file.
    writeFileSync(f1, 'mutated content');
    assert.equal(readFileSync(f1, 'utf8'), 'mutated content');

    restoreSnapshot(snap);
    assert.equal(readFileSync(f1, 'utf8'), 'original');
  } finally {
    cleanup(dir);
  }
});

test('restoreSnapshot handles multiple files', () => {
  const dir = makeTmp();
  try {
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
  } finally {
    cleanup(dir);
  }
});

test('applyChanges writes only files in snapshot', () => {
  const dir = makeTmp();
  try {
    const f1 = join(dir, 'a.mjs');
    writeFileSync(f1, 'original');
    const snap = { [f1]: 'original' };

    const changes = [{ file: f1, content: 'updated' }];
    applyChanges(changes, snap);

    assert.equal(readFileSync(f1, 'utf8'), 'updated');
  } finally {
    cleanup(dir);
  }
});

test('applyChanges throws when file not in snapshot', () => {
  const dir = makeTmp();
  try {
    const f1 = join(dir, 'a.mjs');
    writeFileSync(f1, 'original');
    const snap = { [f1]: 'original' };

    const outsideFile = join(dir, 'outside.mjs');
    const changes = [{ file: outsideFile, content: 'injected' }];

    assert.throws(
      () => applyChanges(changes, snap),
      /not in provided list/
    );
  } finally {
    cleanup(dir);
  }
});

test('snapshot round-trip: take → mutate → restore is stable', () => {
  const dir = makeTmp();
  try {
    const f1 = join(dir, 'file.mjs');
    const original = 'export const x = 1;\nexport const y = 2;\n';
    writeFileSync(f1, original);

    const snap = takeSnapshot([f1]);
    writeFileSync(f1, 'completely different content\n');
    restoreSnapshot(snap);

    assert.equal(readFileSync(f1, 'utf8'), original);
  } finally {
    cleanup(dir);
  }
});
