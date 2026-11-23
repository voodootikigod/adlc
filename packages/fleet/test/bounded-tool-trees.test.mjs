import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_SYSTEM_ROOTS,
  MACOS_SYSTEM_ROOTS,
  SYSTEM_ROOTS,
  classifyReadOnlyEntry,
  checkReadSetInvariant,
} from '../lib/bounded-model-plane.mjs';
import { NODE_TOOL_TREE_RE } from '../lib/extensions.mjs';

test('R1: SYSTEM_ROOTS includes /bin and macOS roots on darwin; classifyReadOnlyEntry recognizes all platform roots', () => {
  assert.ok(BASE_SYSTEM_ROOTS.includes('/bin'));
  assert.ok(SYSTEM_ROOTS.includes('/bin'));
  for (const r of MACOS_SYSTEM_ROOTS) {
    assert.equal(classifyReadOnlyEntry(r, { isFile: () => false }), 'system-root');
  }
  assert.equal(classifyReadOnlyEntry('/bin', { isFile: () => false }), 'system-root');
});

test('R1: NODE_TOOL_TREE_RE allows scoped and unscoped global CLI package trees and rejects bin/root/traversal', () => {
  assert.equal(NODE_TOOL_TREE_RE.test('/usr/local/lib/node_modules/npm'), true);
  assert.equal(NODE_TOOL_TREE_RE.test('/usr/local/lib/node_modules/corepack'), true);
  assert.equal(NODE_TOOL_TREE_RE.test('/opt/node/lib/node_modules/@adlc/cli'), true);
  assert.equal(NODE_TOOL_TREE_RE.test('/opt/node/lib/node_modules/@openai/codex'), true);
  assert.equal(NODE_TOOL_TREE_RE.test('/opt/node/lib/node_modules/adversarial-review'), true);

  assert.equal(NODE_TOOL_TREE_RE.test('/opt/node/bin'), false);
  assert.equal(NODE_TOOL_TREE_RE.test('/opt/node/lib/node_modules'), false);
  assert.equal(NODE_TOOL_TREE_RE.test('/opt/node/lib/node_modules/@adlc'), false);
  assert.equal(NODE_TOOL_TREE_RE.test('/repo/node_modules/evil'), false);
  assert.equal(NODE_TOOL_TREE_RE.test('/opt/node/lib/node_modules/..'), false);
  assert.equal(NODE_TOOL_TREE_RE.test('/opt/node/lib/node_modules/@scope/..'), false);
});

test('R1: checkReadSetInvariant accepts global CLI package trees and rejects <prefix>/bin', () => {
  const pkgTree = '/opt/node/lib/node_modules/@adlc/cli';
  const entryFile = `${pkgTree}/bin/adlc.mjs`;
  const ok = checkReadSetInvariant({
    readOnlyPaths: [...SYSTEM_ROOTS, pkgTree, entryFile],
    writableRoots: ['/srv/wt'],
    home: '/home/op',
    allowedDirs: [pkgTree],
    isFile: (p) => p === entryFile,
  });
  assert.equal(ok.ok, true, ok.violations.join('; '));

  const bad = checkReadSetInvariant({
    readOnlyPaths: [...SYSTEM_ROOTS, '/opt/node/bin'],
    writableRoots: ['/srv/wt'],
    home: '/home/op',
    allowedDirs: [pkgTree],
    isFile: () => false,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.violations.join('\n'), /\/opt\/node\/bin/);
});
