import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRailPath } from '../lib/railpath.mjs';
import { tmp } from '../lib/test-kit.mjs';

function makeRepo(t) {
  const root = realpathSync(tmp(t, 'railpath-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export {}\n');
  return root;
}

test('resolveRailPath: plain existing file resolves to its lexical relative path', (t) => {
  const root = makeRepo(t);
  assert.equal(resolveRailPath('src/app.ts', root), 'src/app.ts');
  assert.equal(resolveRailPath(join(root, 'src/app.ts'), root), 'src/app.ts');
});

test('resolveRailPath: symlinked file resolves to the real rail target', (t) => {
  const root = makeRepo(t);
  symlinkSync(join(root, '.adlc', 'tickets.json'), join(root, 'alias.json'));
  assert.equal(resolveRailPath('alias.json', root), '.adlc/tickets.json');
});

test('resolveRailPath: symlinked parent directory resolves through to the real dir', (t) => {
  const root = makeRepo(t);
  symlinkSync(join(root, '.adlc'), join(root, 'harmless'));
  assert.equal(resolveRailPath('harmless/tickets.json', root), '.adlc/tickets.json');
});

test('resolveRailPath: not-yet-existing file under a symlinked ancestor still resolves', (t) => {
  const root = makeRepo(t);
  symlinkSync(join(root, '.adlc'), join(root, 'harmless'));
  // a `write` creating a new file through the symlinked dir
  assert.equal(resolveRailPath('harmless/current-ticket.json', root), '.adlc/current-ticket.json');
});

test('resolveRailPath: unresolvable paths fall back lexically (relative to root)', (t) => {
  const root = makeRepo(t);
  assert.equal(resolveRailPath('no/such/dir/file.ts', root), 'no/such/dir/file.ts');
});
