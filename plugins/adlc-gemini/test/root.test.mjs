import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { findAdlcRoot, anchorPath } from '../hooks/adlc-rails-guard.mjs';

function repoWithAdlc(t) {
  const root = tmp(t, 'gemini-root-');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), '{"tickets":[]}');
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

test('findAdlcRoot walks up to the .adlc/ ancestor', (t) => {
  const root = repoWithAdlc(t);
  assert.equal(findAdlcRoot(join(root, 'src', 'a.js')), root);
});
test('findAdlcRoot returns null when no .adlc up-tree', (t) => {
  const root = tmp(t, 'gemini-root-');
  assert.equal(findAdlcRoot(join(root, 'a.js')), null);
});
test('anchorPath keeps an absolute path as-is', () => {
  const r = anchorPath('/abs/a.js', {});
  assert.deepEqual(r, { abs: '/abs/a.js', anchored: true });
});
test('anchorPath anchors a relative path via workspacePaths[0]', () => {
  const r = anchorPath('src/a.js', { workspacePaths: ['/ws'] });
  assert.deepEqual(r, { abs: join('/ws', 'src/a.js'), anchored: true });
});
test('anchorPath cannot anchor a relative path with empty workspacePaths', () => {
  const r = anchorPath('src/a.js', { workspacePaths: [] });
  assert.equal(r.anchored, false);
});
