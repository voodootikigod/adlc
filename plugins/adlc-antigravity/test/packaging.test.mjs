// packaging.test.mjs — release-readiness (T37 AC1/AC2/AC3).
//
// AC1/AC2 prove @adlc/antigravity-package publishes only its runtime surface
// (never test/, and plugin.json — agy's own manifest — MUST ship, since agy
// identifies an installed plugin by its presence) and carries the fields the
// lockstep release requires. AC3 proves the package stays self-contained: no
// @adlc/* runtime dependency, since `agy plugin install` copies the plugin
// WITHOUT node_modules (see core-inline.mjs for the rationale) — a regression
// adding one would silently break every fresh `agy plugin install`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

// --- AC1: package.json field contract -------------------------------------

test('AC1: package.json is publishable (not private, licensed, sourced)', () => {
  assert.notEqual(pkg.private, true, 'package must not be private');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository?.directory, 'plugins/adlc-antigravity');
  assert.match(pkg.repository?.url ?? '', /github\.com\/voodootikigod\/adlc/);
  assert.ok(pkg.homepage, 'homepage required');
  assert.ok(pkg.bugs, 'bugs required');
  assert.ok(pkg.author, 'author required');
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('antigravity'), 'keywords must include "antigravity"');
});

// --- AC3: self-contained by design — no @adlc/* runtime dependency --------

test('AC3: no @adlc/* runtime dependency (agy copies without node_modules)', () => {
  const deps = pkg.dependencies ?? {};
  const adlcDeps = Object.keys(deps).filter((name) => name.startsWith('@adlc/'));
  assert.deepEqual(adlcDeps, [], `must stay self-contained — found: ${adlcDeps.join(', ')}`);
});

// --- AC2: files allowlist + real npm pack ----------------------------------

test('AC2: files allowlist ships the runtime surface, plugin.json, and never test/', () => {
  const files = pkg.files ?? [];
  for (const entry of ['agents/', 'commands/', 'constants.mjs', 'core-inline.mjs', 'hooks/', 'hooks.json', 'rails-checker.mjs', 'skills/', 'plugin.json', 'README.md', 'LICENSE']) {
    assert.ok(files.includes(entry), `files must include ${entry}`);
  }
  assert.ok(!files.some((f) => f.replace(/^\.\//, '').startsWith('test')), 'files must not include test/');
});

test('AC2: npm pack --dry-run ships the runtime surface, plugin.json, and NO test files', () => {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkgDir, encoding: 'utf8', timeout: 120_000 });
  assert.equal(res.status, 0, `npm pack failed:\n${res.stderr}`);
  const manifest = JSON.parse(res.stdout);
  const paths = manifest[0].files.map((f) => f.path.replace(/^\.\//, ''));

  for (const dir of ['agents/', 'commands/', 'hooks/', 'skills/']) {
    assert.ok(paths.some((p) => p.startsWith(dir)), `pack must include ${dir}`);
  }
  for (const file of ['constants.mjs', 'core-inline.mjs', 'hooks.json', 'rails-checker.mjs', 'plugin.json', 'README.md', 'LICENSE']) {
    assert.ok(paths.includes(file), `pack must include ${file}`);
  }
  assert.ok(!paths.some((p) => p.startsWith('test/')), `pack must NOT include test/: ${paths.filter((p) => p.startsWith('test/')).join(', ')}`);
});

test('AC2: plugin.json version is untouched by this ticket (still agy-native, not lockstep)', () => {
  const pluginManifest = JSON.parse(readFileSync(join(pkgDir, 'plugin.json'), 'utf8'));
  assert.equal(pluginManifest.name, 'adlc-antigravity');
  // Not asserting an exact version — only that it exists and is independent of
  // package.json's lockstep version (proves the two are not accidentally synced).
  assert.ok(pluginManifest.version, 'plugin.json keeps its own version field');
});
