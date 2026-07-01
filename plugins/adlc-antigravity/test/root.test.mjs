import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAdlcRoot, anchorPath } from '../hooks/adlc-rails-guard.mjs';

function repoWithAdlc() {
  const root = mkdtempSync(join(tmpdir(), 'agy-root-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), '{"tickets":[]}');
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

test('findAdlcRoot walks up to the .adlc/ ancestor', () => {
  const root = repoWithAdlc();
  assert.equal(findAdlcRoot(join(root, 'src', 'a.js')), root);
});
test('findAdlcRoot returns null when no .adlc up-tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-noadlc-'));
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
