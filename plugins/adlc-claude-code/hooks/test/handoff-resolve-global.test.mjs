// handoff-resolve-global.test.mjs — the handoff resolver must find
// @adlc/context-handoff when the ONLY install is the globally-installed
// @adlc/cli that both plugins document.
//
// Issue #526: the resolver anchored solely on (a) the project root and (b) a
// walk-up from the plugin's own install directory. `npm install -g @adlc/cli`
// — the single route plugins/adlc-codex/README.md and docs/integrations/codex.md
// document — lands the package at <npm root -g>/@adlc/cli/node_modules/
// @adlc/context-handoff, on neither path. The handoff gate fails closed when
// resolution returns null, so a user who followed the README exactly lost every
// mutating tool call and every shell call for the whole session.
//
// Fail-closed is deliberate and stays: the fix widens WHERE the package is
// looked for, it does not make an absent package allow. The last test here pins
// that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveContextHandoffEntry } from '../handoff-resolve.mjs';

const HOOKS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Write a minimal but real @adlc/context-handoff package under `nodeModulesDir`. */
function plantPackage(nodeModulesDir, { name = '@adlc/context-handoff' } = {}) {
  const [scope, bare] = name.split('/');
  const pkgDir = join(nodeModulesDir, scope, bare);
  mkdirSync(join(pkgDir, 'lib'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0-test', type: 'module', exports: { '.': './lib/index.mjs' } }),
  );
  const entry = join(pkgDir, 'lib', 'index.mjs');
  writeFileSync(entry, 'export const planted = true;\n');
  return { pkgDir, entry };
}

/** A sandbox far from this repo, so the plugin-ancestry walk cannot find anything. */
function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-handoff-global-')));
  const projectRoot = join(root, 'project');
  const pluginHooksDir = join(root, 'plugin', 'hooks');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(pluginHooksDir, { recursive: true });
  return { root, projectRoot, pluginHooksDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A POSIX npm prefix: <prefix>/bin/node, packages under <prefix>/lib/node_modules. */
function posixPrefix(root) {
  const prefix = join(root, 'npm-prefix');
  const globalRoot = join(prefix, 'lib', 'node_modules');
  mkdirSync(globalRoot, { recursive: true });
  return { execPath: join(prefix, 'bin', 'node'), globalRoot };
}

test('resolves the nested layout a global @adlc/cli install actually produces', () => {
  const box = sandbox();
  try {
    const { execPath, globalRoot } = posixPrefix(box.root);
    const cliNodeModules = join(globalRoot, '@adlc', 'cli', 'node_modules');
    mkdirSync(join(globalRoot, '@adlc', 'cli'), { recursive: true });
    writeFileSync(
      join(globalRoot, '@adlc', 'cli', 'package.json'),
      JSON.stringify({ name: '@adlc/cli', version: '0.0.0-test', type: 'module' }),
    );
    const { entry } = plantPackage(cliNodeModules);

    const found = resolveContextHandoffEntry({
      projectRoot: box.projectRoot,
      pluginHooksDir: box.pluginHooksDir,
      env: {},
      execPath,
    });
    assert.equal(found && realpathSync(found), entry);
  } finally {
    box.cleanup();
  }
});

test('resolves the hoisted global layout too', () => {
  const box = sandbox();
  try {
    const { execPath, globalRoot } = posixPrefix(box.root);
    const { entry } = plantPackage(globalRoot);

    const found = resolveContextHandoffEntry({
      projectRoot: box.projectRoot,
      pluginHooksDir: box.pluginHooksDir,
      env: {},
      execPath,
    });
    assert.equal(found && realpathSync(found), entry);
  } finally {
    box.cleanup();
  }
});

test('resolves the Windows-style prefix where packages sit beside the node binary', () => {
  const box = sandbox();
  try {
    const prefix = join(box.root, 'win-prefix');
    const globalRoot = join(prefix, 'node_modules');
    mkdirSync(globalRoot, { recursive: true });
    const { entry } = plantPackage(globalRoot);

    const found = resolveContextHandoffEntry({
      projectRoot: box.projectRoot,
      pluginHooksDir: box.pluginHooksDir,
      env: {},
      execPath: join(prefix, 'node.exe'),
    });
    assert.equal(found && realpathSync(found), entry);
  } finally {
    box.cleanup();
  }
});

test('resolves a directory listed in NODE_PATH', () => {
  const box = sandbox();
  try {
    const nodePathDir = join(box.root, 'extra-modules');
    mkdirSync(nodePathDir, { recursive: true });
    const { entry } = plantPackage(nodePathDir);

    const found = resolveContextHandoffEntry({
      projectRoot: box.projectRoot,
      pluginHooksDir: box.pluginHooksDir,
      env: { NODE_PATH: [join(box.root, 'absent'), nodePathDir].join(delimiter) },
      execPath: join(box.root, 'no-such-prefix', 'bin', 'node'),
    });
    assert.equal(found && realpathSync(found), entry);
  } finally {
    box.cleanup();
  }
});

test('a project-local copy still wins over a global one', () => {
  const box = sandbox();
  try {
    const { execPath, globalRoot } = posixPrefix(box.root);
    const global = plantPackage(globalRoot);
    const local = plantPackage(join(box.projectRoot, 'node_modules'));
    writeFileSync(
      join(box.projectRoot, 'package.json'),
      JSON.stringify({ name: 'consumer', version: '0.0.0', type: 'module' }),
    );

    const found = resolveContextHandoffEntry({
      projectRoot: box.projectRoot,
      pluginHooksDir: box.pluginHooksDir,
      env: {},
      execPath,
    });
    assert.equal(found && realpathSync(found), local.entry);
    assert.notEqual(found && realpathSync(found), global.entry);
  } finally {
    box.cleanup();
  }
});

test('still returns null when the package is installed nowhere — the gate stays fail-closed', () => {
  const box = sandbox();
  try {
    const found = resolveContextHandoffEntry({
      projectRoot: box.projectRoot,
      pluginHooksDir: box.pluginHooksDir,
      env: {},
      execPath: join(box.root, 'no-such-prefix', 'bin', 'node'),
    });
    assert.equal(found, null);
  } finally {
    box.cleanup();
  }
});

test('the default env/execPath still resolve this repo from the real plugin directory', () => {
  const found = resolveContextHandoffEntry({ projectRoot: null, pluginHooksDir: HOOKS_DIR });
  assert.ok(found, 'the monorepo walk-up must keep working');
  assert.match(found, /context-handoff/);
});

test('the recovery diagnostic stops naming a monorepo path when nothing resolves', async () => {
  const { recoveryDiagnostic } = await import('../adlc-hook.mjs');
  const message = recoveryDiagnostic('sess-global', { resolveEntry: () => null });

  assert.equal(typeof message, 'string');
  assert.ok(message.length > 0, 'an operator with no install still needs a way out');
  assert.match(message, /@adlc\/context-handoff/, 'it must name what could not be resolved');
  assert.match(message, /npm install -g @adlc\/cli/, 'and how to make it resolvable');
  assert.doesNotMatch(
    message,
    /packages\/context-handoff\//,
    'a path that exists only in a source checkout of this monorepo is not a recovery route',
  );
});
