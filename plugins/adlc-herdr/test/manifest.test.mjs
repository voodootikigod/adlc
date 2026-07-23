// Offline manifest smoke (t-herdr-1, AC2): the shipped herdr-plugin.toml is
// shape-valid, declares no [[build]] commands (plan §6.6), and every declared
// node entrypoint exists and passes syntax check. The parser is also exercised
// against a full-entrypoint example and known-bad inputs; the "every declared
// node entrypoint" test now walks the real shipped entrypoints
// ([[startup]]/[[panes]]/[[actions]]).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, validateManifest } from '../lib/manifest.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(pluginRoot, 'herdr-plugin.toml');

function loadShipped() {
  return parseManifest(readFileSync(manifestPath, 'utf8'));
}

test('shipped manifest parses and validates with zero errors', () => {
  const parsed = loadShipped();
  assert.deepEqual(validateManifest(parsed), []);
});

test('shipped manifest declares the pinned identity', () => {
  const { top } = loadShipped();
  assert.equal(top.id, 'adlc');
  assert.equal(top.name, 'ADLC');
  assert.equal(top.min_herdr_version, '0.7.4');
  assert.deepEqual(top.platforms, ['linux', 'macos']);
});

test('shipped manifest declares no [[build]] commands (plan §6.6)', () => {
  const { sections } = loadShipped();
  assert.deepEqual(sections.filter((s) => s.name === 'build'), []);
});

test('every declared node entrypoint exists and passes node --check', () => {
  const { sections } = loadShipped();
  for (const { name, entries } of sections) {
    if (!Array.isArray(entries.command) || entries.command[0] !== 'node') continue;
    const file = join(pluginRoot, entries.command[1]);
    assert.ok(existsSync(file), `[[${name}]] entrypoint missing: ${entries.command[1]}`);
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, `[[${name}]] entrypoint fails node --check: ${check.stderr}`);
  }
});

test('every bin/*.mjs passes node --check, declared in the manifest or not', () => {
  const binDir = join(pluginRoot, 'bin');
  const files = readdirSync(binDir).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length > 0, 'bin/ must not be empty');
  for (const file of files) {
    const check = spawnSync(process.execPath, ['--check', join(binDir, file)], { encoding: 'utf8' });
    assert.equal(check.status, 0, `bin/${file} fails node --check: ${check.stderr}`);
  }
});

test('parser handles the full entrypoint surface (probed 2026-07-23 doc shapes)', () => {
  const example = [
    'id = "example.layout"',
    'name = "Layout"',
    'version = "0.1.0"',
    'min_herdr_version = "0.7.0"',
    '[[startup]]',
    'command = ["node", "dist/restore.js"]',
    '[[actions]]',
    'id = "apply"',
    'title = "Apply layout"',
    'contexts = ["workspace"]',
    'command = ["node", "dist/apply.js"]',
    '[[events]]',
    'on = "worktree.created"',
    'command = ["node", "dist/on-event.js"]',
    '[[panes]]',
    'id = "board"',
    'title = "Project board"',
    'placement = "overlay"',
    'command = ["node", "dist/board.js"]',
    '[[link_handlers]]',
    'id = "gh"',
    'pattern = "^https://github/"',
    'action = "apply"',
  ].join('\n');
  const parsed = parseManifest(example);
  assert.deepEqual(validateManifest(parsed), []);
  assert.equal(parsed.sections.length, 5);
  assert.equal(parsed.sections.find((s) => s.name === 'events').entries.on, 'worktree.created');
});

test('parser fails closed on lines outside the supported subset', () => {
  assert.throws(() => parseManifest('id = bare_word'));
  assert.throws(() => parseManifest('key = "a" # trailing comment'));
  assert.throws(() => parseManifest('[table]'));
  assert.throws(() => parseManifest(42));
});

test('[[keys.command]] sections are known and carry no command-array requirement', () => {
  const parsed = parseManifest([
    'id = "adlc"', 'name = "ADLC"', 'version = "0.1.0"', 'min_herdr_version = "0.7.4"',
    '[[keys.command]]',
    'key = "prefix+l"',
    'type = "plugin_action"',
    'command = "adlc.board"',
  ].join('\n'));
  assert.deepEqual(validateManifest(parsed), []);
});

test('validator reports missing identity, malformed entrypoints, unknown sections', () => {
  const errs = validateManifest(parseManifest([
    'name = "x"',
    '[[actions]]',
    'command = "not-an-array"',
    '[[events]]',
    'command = ["node", "x.js"]',
    '[[mystery]]',
    'command = ["node", "y.js"]',
  ].join('\n')));
  assert.ok(errs.some((e) => e.includes('top-level id')));
  assert.ok(errs.some((e) => e.includes('[[actions]] requires a command array')));
  assert.ok(errs.some((e) => e.includes('[[events]] requires string on')));
  assert.ok(errs.some((e) => e.includes('unknown section [[mystery]]')));
});
