import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCustomTool, pathInScope, railHit } from '../lib/rails-checker.mjs';

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-pi-ancestor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src', 'frozen'), { recursive: true });
  mkdirSync(join(dir, 'packages', 'secret'), { recursive: true });
  writeFileSync(join(dir, 'src', 'frozen', 'guard.mjs'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'packages', 'secret', 'key.mjs'), 'export const k = 1;\n');
  symlinkSync(join(dir, 'packages', 'secret', 'key.mjs'), join(dir, 'src', 'escape-link.mjs'));
  return dir;
}

test('railHit blocks ancestor-directory deletion for concrete and wildcard rails', (t) => {
  const root = makeRepo(t);
  const ticket = { id: 'T1', rails: ['src/frozen/guard.mjs'], scope: ['src/**'] };
  assert.equal(railHit('src/frozen', ticket, root), 'src/frozen/guard.mjs');
  assert.equal(railHit('src', ticket, root), 'src/frozen/guard.mjs');
  assert.equal(railHit('src/frozen-other', ticket, root), null);

  const wildSingle = { id: 'T2', rails: ['src/*/guard.mjs'], scope: ['src/**'] };
  assert.equal(railHit('src/frozen', wildSingle, root), 'src/*/guard.mjs');

  const wildDeep = { id: 'T3', rails: ['src/**/guard.mjs'], scope: ['src/**'] };
  assert.equal(railHit('src/frozen', wildDeep, root), 'src/**/guard.mjs');
  assert.equal(railHit('src', wildDeep, root), 'src/**/guard.mjs');
});

test('pathInScope resolves symlinks and rejects an in-scope symlink pointing outside ticket scope', (t) => {
  const root = makeRepo(t);
  const ticket = { id: 'T1', rails: ['src/frozen/guard.mjs'], scope: ['src/**'] };
  assert.equal(pathInScope('src/escape-link.mjs', ticket, root), false);
  assert.equal(pathInScope('src/ok.mjs', ticket, root), true);
});

test('checkCustomTool fails closed on no-target custom tools when active ticket has rails, and stays advisory when unrailed', (t) => {
  const root = makeRepo(t);
  const railed = { id: 'T1', rails: ['src/frozen/guard.mjs'], scope: ['src/**'] };
  const unrailed = { id: 'T2', rails: [], scope: ['src/**'] };

  const denied = checkCustomTool('opaque_custom_tool', {}, railed, root);
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.unvetted, true);

  const allowed = checkCustomTool('opaque_custom_tool', {}, unrailed, root);
  assert.equal(allowed.decision, 'allow');
  assert.equal(allowed.unvetted, true);
});
