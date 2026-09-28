// resolveRailPath must name the file the kernel would write, resolving each
// segment in order: a `..` applies to the symlink-resolved prefix before it,
// and a symlink whose own target does not exist yet still redirects the write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRailPath } from '../lib/railpath.mjs';
import { tmp } from '../lib/test-kit.mjs';

function makeRepo(t) {
  const root = tmp(t, 'railpath-kernel-');
  mkdirSync(join(root, 'test'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.adlc', 'tickets'), { recursive: true });
  mkdirSync(join(root, 'packages', 'core'), { recursive: true });
  writeFileSync(join(root, 'test', 'a.test.mjs'), '// rail\n');
  symlinkSync('../test', join(root, 'src', 'alias'));
  return root;
}

test('a `..` after a symlinked directory applies to the link target, not the link name', (t) => {
  const root = makeRepo(t);
  const input = 'src/alias/../test/a.test.mjs';
  assert.equal(resolveRailPath(input, root), 'test/a.test.mjs');
  // Ground truth: the kernel writes into the rail through this exact string.
  writeFileSync(`${root}/${input}`, 'overwritten\n'); // unjoined: path.join would fold the `..`
  assert.equal(readFileSync(join(root, 'test', 'a.test.mjs'), 'utf8'), 'overwritten\n');
});

test('a `..` climb through a package symlink reaches the ticket store', (t) => {
  const root = makeRepo(t);
  mkdirSync(join(root, 'node_modules', '@adlc'), { recursive: true });
  symlinkSync('../../packages/core', join(root, 'node_modules', '@adlc', 'core'));
  assert.equal(
    resolveRailPath('node_modules/@adlc/core/../../.adlc/tickets/x.json', root),
    '.adlc/tickets/x.json',
  );
});

test('an absolute input with `..` after a symlink resolves in kernel order', (t) => {
  const root = makeRepo(t);
  assert.equal(resolveRailPath(join(root, 'src', 'alias') + '/../test/new.mjs', root), 'test/new.mjs');
});

test('a `..` after plain directories still folds as before', (t) => {
  const root = makeRepo(t);
  assert.equal(resolveRailPath('src/../test/a.test.mjs', root), 'test/a.test.mjs');
  assert.equal(resolveRailPath('./src/./x.mjs', root), 'src/x.mjs');
});

test('a dangling symlink resolves to the file the write would create', (t) => {
  const root = makeRepo(t);
  symlinkSync('test/new.test.mjs', join(root, 'alias.mjs'));
  assert.equal(resolveRailPath('alias.mjs', root), 'test/new.test.mjs');
});

test('a dangling symlink into a missing directory still names the rail path', (t) => {
  const root = makeRepo(t);
  symlinkSync('test/sub/new.test.mjs', join(root, 'alias.mjs'));
  assert.equal(resolveRailPath('alias.mjs', root), 'test/sub/new.test.mjs');
});

test('a dangling absolute symlink resolves to its absolute target', (t) => {
  const root = makeRepo(t);
  symlinkSync(join(root, 'test', 'abs.test.mjs'), join(root, 'abs-alias.mjs'));
  assert.equal(resolveRailPath('abs-alias.mjs', root), 'test/abs.test.mjs');
});

test('a dangling directory symlink redirects children created beneath it', (t) => {
  const root = makeRepo(t);
  symlinkSync('test/later', join(root, 'dirlink'));
  assert.equal(resolveRailPath('dirlink/x.mjs', root), 'test/later/x.mjs');
});
