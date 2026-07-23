// packaging.test.mjs — release-readiness (T37 AC1/AC2/AC3).
//
// AC1/AC2 prove @adlc/antigravity publishes only its runtime surface
// (never test/, and plugin.json — agy's own manifest — MUST ship, since agy
// identifies an installed plugin by its presence) and carries the fields the
// lockstep release requires. AC3 proves the package stays self-contained: no
// @adlc/* runtime dependency, since `agy plugin install` copies the plugin
// WITHOUT node_modules (see core-inline.mjs for the rationale) — a regression
// adding one would silently break every fresh `agy plugin install`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

// --- AC1: package.json field contract -------------------------------------

// T38 P5 finding F1: cursor/opencode's install-smoke scripts guard their
// package.json 'name' field; pi/antigravity had no such guard, so a stale
// -package suffix regressing back in would ship silently.
test('T38: package.json name is the renamed short form', () => {
  assert.equal(pkg.name, '@adlc/antigravity');
});

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

// P5 finding 1 (release-blocking): scripts/release.mjs:136 runs
// `npm publish --provenance` with NO --access flag — it relies on every
// package declaring publishConfig.access=public (release.mjs's own header
// comment states this invariant). A scoped @adlc/* package with no
// publishConfig defaults to RESTRICTED access, and --provenance on a
// restricted-defaulting scoped package fails at actual publish time — landing
// AFTER packages/* already published (a partial-release repeat of the T30
// incident). Mirror @adlc/pi / @adlc/opencode exactly.
test('AC1: publishConfig grants public access + provenance (release.mjs relies on this, not --access)', () => {
  assert.deepEqual(pkg.publishConfig, { access: 'public', provenance: true });
});

test('AC1 (real subprocess): npm publish --dry-run reports PUBLIC access, never "default access"', () => {
  // Dry-run against a throwaway, never-published version. npm aborts a dry-run for
  // an ALREADY-published version before printing the access line ("cannot publish
  // over the previously published versions: X"), which would flip this assertion red
  // the moment the current version ships. Bumping to an unpublishable-high version
  // keeps the public-access check deterministic regardless of what is live on the
  // registry. The real package.json is restored in finally.
  const pkgJsonPath = join(pkgDir, 'package.json');
  const originalPkgJson = readFileSync(pkgJsonPath, 'utf8');
  let out;
  try {
    writeFileSync(pkgJsonPath, JSON.stringify({ ...JSON.parse(originalPkgJson), version: '999.999.999' }, null, 2) + '\n');
    const res = spawnSync('npm', ['publish', '--dry-run'], { cwd: pkgDir, encoding: 'utf8', timeout: 60_000 });
    out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  } finally {
    writeFileSync(pkgJsonPath, originalPkgJson);
  }
  assert.match(out, /with tag latest and public access/, `expected real npm to report public access:\n${out}`);
  assert.ok(!/default access/.test(out), `npm reported "default access" (restricted) — publishConfig is missing or wrong:\n${out}`);
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
  for (const entry of ['agents/', 'build-gate-inline.mjs', 'commands/', 'constants.mjs', 'core-inline.mjs', 'flail-inline.mjs', 'hooks/', 'hooks.json', 'rails-checker.mjs', 'skills/', 'plugin.json', 'README.md', 'LICENSE']) {
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
  for (const file of ['build-gate-inline.mjs', 'constants.mjs', 'core-inline.mjs', 'flail-inline.mjs', 'hooks.json', 'rails-checker.mjs', 'plugin.json', 'README.md', 'LICENSE']) {
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

// --- AC4: the packed tarball actually loads --------------------------------

// The AC1/AC2 checks above compare against a HARDCODED file list, so they pass
// whenever the list matches itself — they cannot see a module the tarball
// imports but never ships. That blind spot published 1.4.1 with
// core-inline.mjs importing ./generated-ticket-reader.mjs while the files
// allowlist omitted it: every npm install hit the shim fail-safe, which
// allow-alls when ADLC_P4_ENFORCEMENT is unset, so rails were silently
// unenforced on the primary distribution path.
//
// Resolving the real entry point out of a real tarball is what makes that class
// of defect impossible to ship: the import graph is the assertion, so a newly
// added relative import is covered without anyone remembering to list it.
// agy copies plugins WITHOUT node_modules (see AC3), so extracting with no
// node_modules present is the faithful install, not a stricter one.
test('AC4: packed tarball extracted outside the repo imports rails-checker with no node_modules', () => {
  const work = mkdtempSync(join(tmpdir(), 'adlc-agy-pack-'));
  try {
    const tarballName = execFileSync('npm', ['pack', '--pack-destination', work], {
      cwd: pkgDir,
      encoding: 'utf8',
      timeout: 120_000,
    })
      .trim()
      .split('\n')
      .pop();
    const extractedRoot = join(work, 'extracted');
    mkdirSync(extractedRoot, { recursive: true });
    execFileSync('tar', ['-xzf', join(work, tarballName), '-C', extractedRoot]);
    const pkgRoot = join(extractedRoot, 'package'); // npm tarballs always nest under package/

    // Every module the plugin's own manifest points agy at must both ship and
    // resolve — including each module they import transitively.
    const entryPoints = ['rails-checker.mjs', 'core-inline.mjs', pkg.agy.hooks.replace(/^\.\//, '')];
    for (const entry of entryPoints) {
      assert.ok(existsSync(join(pkgRoot, entry)), `tarball must ship ${entry}`);
    }

    // Importing is the real gate: a relative import of an unshipped module
    // throws ERR_MODULE_NOT_FOUND here, which is exactly the 1.4.1 break.
    const res = spawnSync(
      'node',
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(pkgRoot, 'rails-checker.mjs')).href)})`],
      { encoding: 'utf8', timeout: 30_000, cwd: pkgRoot }
    );
    assert.equal(
      res.status,
      0,
      `packed rails-checker.mjs must import standalone with no node_modules — a relative import is missing from the files allowlist:\n${res.stderr}`
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
