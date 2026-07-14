// packaging.test.mjs — release-readiness (T37 AC1/AC2/AC4).
//
// AC1/AC2 prove @adlc/cursor publishes only its runtime surface (never
// test/) and carries the fields the lockstep release requires. AC4 proves the
// packed tarball is self-sufficient and its bin entry runs standalone — pack a
// REAL tarball, extract it OUTSIDE the repo tree, resolve its one external
// dependency (@adlc/core) via a workspace symlink (what a real `npm install`
// produces, without hitting the network in CI), and run the scaffold against a
// fresh temp target repo. If anything outside the `files` allowlist were needed
// at runtime, this fails with a module-not-found error that `npm pack
// --dry-run` alone cannot catch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const repoRoot = resolve(here, '..', '..', '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

// --- AC1: package.json field contract -------------------------------------

test('AC1: package.json is publishable (not private, licensed, sourced)', () => {
  assert.notEqual(pkg.private, true, 'package must not be private');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository?.directory, 'plugins/adlc-cursor');
  assert.match(pkg.repository?.url ?? '', /github\.com\/voodootikigod\/adlc/);
  assert.ok(pkg.homepage, 'homepage required');
  assert.ok(pkg.bugs, 'bugs required');
  assert.ok(pkg.author, 'author required');
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('cursor'), 'keywords must include "cursor"');
});

test('AC1: @adlc/* runtime deps stay in dependencies (installed under --omit=dev)', () => {
  for (const name of ['@adlc/core', '@adlc/build-gate', '@adlc/flail-detector']) {
    assert.ok(pkg.dependencies?.[name], `${name} must be a runtime dependency`);
  }
});

// P5 finding 1 (release-blocking): scripts/release.mjs:136 runs
// `npm publish --provenance` with NO --access flag — it relies on every
// package declaring publishConfig.access=public (release.mjs's own header
// comment states this invariant). A scoped @adlc/* package with no
// publishConfig defaults to RESTRICTED access, and --provenance on a
// restricted-defaulting scoped package fails at actual publish time — exactly
// the failure this package's private:true removal would otherwise walk into,
// landing AFTER packages/* already published (a partial-release repeat of the
// T30 incident). Mirror @adlc/pi / @adlc/opencode exactly.
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

// --- AC2: files allowlist + real npm pack ----------------------------------

test('AC2: files allowlist ships the runtime surface and never test/', () => {
  const files = pkg.files ?? [];
  for (const entry of ['command/', 'constants.mjs', 'hooks/', 'hooks.json', 'lib/', 'rails-checker.mjs', 'rules/', 'README.md', 'LICENSE']) {
    assert.ok(files.includes(entry), `files must include ${entry}`);
  }
  assert.ok(!files.some((f) => f.replace(/^\.\//, '').startsWith('test')), 'files must not include test/');
});

test('AC2: npm pack --dry-run ships the runtime surface and NO test files', () => {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkgDir, encoding: 'utf8', timeout: 120_000 });
  assert.equal(res.status, 0, `npm pack failed:\n${res.stderr}`);
  const manifest = JSON.parse(res.stdout);
  const paths = manifest[0].files.map((f) => f.path.replace(/^\.\//, ''));

  for (const dir of ['command/', 'hooks/', 'lib/', 'rules/']) {
    assert.ok(paths.some((p) => p.startsWith(dir)), `pack must include ${dir}`);
  }
  for (const file of ['constants.mjs', 'hooks.json', 'rails-checker.mjs', 'README.md', 'LICENSE']) {
    assert.ok(paths.includes(file), `pack must include ${file}`);
  }
  assert.ok(!paths.some((p) => p.startsWith('test/')), `pack must NOT include test/: ${paths.filter((p) => p.startsWith('test/')).join(', ')}`);
});

// --- AC4: the packed tarball is self-sufficient; the bin runs standalone ---

test('AC4: packed tarball extracted outside the repo runs adlc-cursor-scaffold standalone', () => {
  const work = mkdtempSync(join(tmpdir(), 'adlc-cursor-pack-'));
  const targetRepo = mkdtempSync(join(tmpdir(), 'adlc-cursor-target-'));
  try {
    // 1. Pack a REAL tarball (not --dry-run) into an isolated temp dir.
    const tarballName = execFileSync('npm', ['pack', '--pack-destination', work], { cwd: pkgDir, encoding: 'utf8' }).trim().split('\n').pop();
    const tarballPath = join(work, tarballName);
    assert.ok(existsSync(tarballPath), 'npm pack produced a tarball');

    // 2. Extract it OUTSIDE plugins/adlc-cursor — proves the bin's relative
    //    imports (constants.mjs, ../rails-checker.mjs consumers, etc.) resolve
    //    from wherever the package lands, not from a hardcoded repo path.
    const extractedRoot = join(work, 'extracted');
    mkdirSync(extractedRoot, { recursive: true });
    execFileSync('tar', ['-xzf', tarballPath, '-C', extractedRoot]);
    const pkgRoot = join(extractedRoot, 'package'); // npm tarballs always nest under package/

    // 3. Resolve the one external dependency (@adlc/core) via a workspace
    //    symlink — exactly what `npm install` produces for a workspace
    //    package, without a real registry round-trip in CI.
    const nodeModules = join(pkgRoot, 'node_modules', '@adlc');
    mkdirSync(nodeModules, { recursive: true });
    symlinkSync(join(repoRoot, 'node_modules', '@adlc', 'core'), join(nodeModules, 'core'));

    // 4. Run the packed bin standalone against a fresh temp target repo.
    const binPath = join(pkgRoot, pkg.bin[Object.keys(pkg.bin)[0]]);
    assert.ok(existsSync(binPath), 'bin entry point exists in the extracted tarball');
    const res = spawnSync('node', [binPath, targetRepo], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(res.status, 0, `standalone scaffold run failed:\n${res.stdout}\n${res.stderr}`);

    // 5. Assert the real scaffold output landed in the target repo.
    assert.ok(existsSync(join(targetRepo, '.adlc', 'config.json')), '.adlc/config.json created');
    assert.ok(existsSync(join(targetRepo, '.cursor', 'hooks.json')), '.cursor/hooks.json created');
    assert.ok(existsSync(join(targetRepo, '.cursor', 'rules', 'adlc.mdc')), '.cursor/rules/adlc.mdc created');
    assert.ok(existsSync(join(targetRepo, '.cursor', 'commands', 'adlc-init.md')), 'command palette deployed');
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
  }
});
