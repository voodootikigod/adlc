import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRailPath } from '../lib/railpath.mjs';

function makeRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'railpath-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export {}\n');
  return root;
}

test('resolveRailPath: plain existing file resolves to its lexical relative path', () => {
  const root = makeRepo();
  try {
    assert.equal(resolveRailPath('src/app.ts', root), 'src/app.ts');
    assert.equal(resolveRailPath(join(root, 'src/app.ts'), root), 'src/app.ts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveRailPath: symlinked file resolves to the real rail target', () => {
  const root = makeRepo();
  try {
    symlinkSync(join(root, '.adlc', 'tickets.json'), join(root, 'alias.json'));
    assert.equal(resolveRailPath('alias.json', root), '.adlc/tickets.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveRailPath: symlinked parent directory resolves through to the real dir', () => {
  const root = makeRepo();
  try {
    symlinkSync(join(root, '.adlc'), join(root, 'harmless'));
    assert.equal(resolveRailPath('harmless/tickets.json', root), '.adlc/tickets.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveRailPath: not-yet-existing file under a symlinked ancestor still resolves', () => {
  const root = makeRepo();
  try {
    symlinkSync(join(root, '.adlc'), join(root, 'harmless'));
    // a `write` creating a new file through the symlinked dir
    assert.equal(resolveRailPath('harmless/current-ticket.json', root), '.adlc/current-ticket.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveRailPath: unresolvable paths fall back lexically (relative to root)', () => {
  const root = makeRepo();
  try {
    assert.equal(resolveRailPath('no/such/dir/file.ts', root), 'no/such/dir/file.ts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
