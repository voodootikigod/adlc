// railpath-deep-ancestor.test.mjs — regression tests for issue #1062
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep, relative } from 'node:path';
import { resolveRailPath } from '../lib/railpath.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'railpath-deep-'));
  dirs.push(dir);
  const root = realpathSync(dir);
  mkdirSync(join(root, 'test'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'test', 'a.test.mjs'), '// test file\n');
  symlinkSync('../test', join(root, 'src', 'alias'));
  return root;
}

// AC1: deep ancestor resolution across symlinks
test('resolveRailPath: non-existent file in new subdirectory under symlinked dir resolves through to real rail', () => {
  const root = makeRepo();
  assert.equal(resolveRailPath('src/alias/newdir/x.test.mjs', root), 'test/newdir/x.test.mjs');
});

test('resolveRailPath: non-existent file deep in missing subdirectories preserves tail order', () => {
  const root = makeRepo();
  assert.equal(resolveRailPath('src/alias/n1/n2/n3/x.test.mjs', root), 'test/n1/n2/n3/x.test.mjs');
});

test('resolveRailPath: absolute input resolves through to relative rail path', () => {
  const root = makeRepo();
  assert.equal(resolveRailPath(join(root, 'src/alias/newdir/x.test.mjs'), root), 'test/newdir/x.test.mjs');
});

test('resolveRailPath: trailing slash resolves through without trailing slash', () => {
  const root = makeRepo();
  assert.equal(resolveRailPath('src/alias/n1/n2/', root), 'test/n1/n2');
});

test('resolveRailPath: chained symlinks resolve through to real rail', () => {
  const root = makeRepo();
  symlinkSync('src/alias', join(root, 'hop'));
  assert.equal(resolveRailPath('hop/newdir/x.test.mjs', root), 'test/newdir/x.test.mjs');
});

test('resolveRailPath: symlinked root resolves through to target rail', () => {
  const root = makeRepo();
  const other = mkdtempSync(join(tmpdir(), 'railpath-deep-'));
  dirs.push(other);
  const repo = join(other, 'repo');
  symlinkSync(root, repo);
  assert.equal(resolveRailPath('src/alias/newdir/x.test.mjs', repo), 'test/newdir/x.test.mjs');
});

// AC2: guards that pass before and after
test('resolveRailPath: missing path without symlinks remains unchanged', () => {
  const root = makeRepo();
  assert.equal(resolveRailPath('src/new/deeper/file.ts', root), 'src/new/deeper/file.ts');
});

test('resolveRailPath: symlink loop does not cause infinite recursion and falls back lexically', { timeout: 5000 }, () => {
  const root = makeRepo();
  symlinkSync('loopB', join(root, 'loopA'));
  symlinkSync('loopA', join(root, 'loopB'));
  assert.equal(resolveRailPath('loopA/d/x.mjs', root), 'loopA/d/x.mjs');
});

test('resolveRailPath: absolute path with non-existent root segment terminates at filesystem root', { timeout: 5000 }, () => {
  const root = makeRepo();
  const abs = join(sep, 'railpath-absent-' + process.pid, 'a', 'b.mjs');
  assert.equal(resolveRailPath(abs, root), relative(root, abs).split(sep).join('/'));
});

test('resolveRailPath: regular file as an ancestor does not throw and remains unchanged', () => {
  const root = makeRepo();
  assert.equal(resolveRailPath('test/a.test.mjs/child/x', root), 'test/a.test.mjs/child/x');
});
