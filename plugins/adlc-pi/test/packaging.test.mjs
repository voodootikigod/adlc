// packaging.test.mjs — release-readiness (T29 AC1) + version-matrix wiring (AC3).
//
// AC1 proves @adlc/pi publishes only its runtime surface (never test/)
// and carries the fields the lockstep release + pi.dev gallery require.
// AC3 proves scripts/pi-live-deny.mjs honors the ADLC_PI_BIN override and that
// the version-matrix verdict table gates exactly as specified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { matrixVerdict } from '../../../scripts/pi-version-matrix.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const repoRoot = resolve(here, '..', '..', '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

// --- AC1: package.json field contract -------------------------------------

// T38 P5 finding F1: cursor/opencode's install-smoke scripts guard their
// package.json 'name' field; pi/antigravity had no such guard, so a stale
// -package suffix regressing back in would ship silently. pi publishes next.
test('T38: package.json name is the renamed short form', () => {
  assert.equal(pkg.name, '@adlc/pi');
});

test('AC1: package.json is publishable (not private, licensed, sourced)', () => {
  assert.notEqual(pkg.private, true, 'package must not be private');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository?.directory, 'plugins/adlc-pi');
  assert.match(pkg.repository?.url ?? '', /github\.com\/voodootikigod\/adlc/);
  assert.ok(pkg.homepage, 'homepage required');
  assert.ok(pkg.bugs, 'bugs required');
  assert.ok(pkg.author, 'author required');
});

test('AC1: keywords include pi-package (pi.dev gallery listing)', () => {
  assert.ok(Array.isArray(pkg.keywords), 'keywords must be an array');
  assert.ok(pkg.keywords.includes('pi-package'), 'keywords must include "pi-package"');
});

test('AC1: pi core peer is pinned to "*" (never bundled)', () => {
  assert.equal(pkg.peerDependencies?.['@earendil-works/pi-coding-agent'], '*');
  // The pi runtime peer must not leak into dependencies (would get bundled/installed).
  assert.equal(pkg.dependencies?.['@earendil-works/pi-coding-agent'], undefined);
});

// ALL five pi-runtime core packages must resolve from the pi install (peers /
// dynamic imports), never from this package's dependencies — installing them
// would bundle a second, conflicting pi runtime. The peer declaration only
// needs pi-coding-agent, but a dep-list regression adding ANY of the five must
// fail here (P5 finding F1: only pi-coding-agent was guarded before).
test('AC1: no pi-runtime core package leaks into dependencies (all five)', () => {
  const PI_CORE = [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-tui',
    'typebox',
  ];
  const deps = pkg.dependencies ?? {};
  const bundled = pkg.bundledDependencies ?? pkg.bundleDependencies ?? [];
  for (const name of PI_CORE) {
    assert.equal(deps[name], undefined, `${name} must not be a runtime dependency (bundles a second pi runtime)`);
    assert.ok(!bundled.includes(name), `${name} must not be bundled`);
  }
});

test('AC1: @adlc/* runtime deps stay in dependencies (installed under --omit=dev)', () => {
  for (const name of ['@adlc/core', '@adlc/rails-guard', '@adlc/build-gate', '@adlc/flail-detector', '@adlc/gate-manifest']) {
    assert.ok(pkg.dependencies?.[name], `${name} must be a runtime dependency`);
  }
});

test('AC1: files allowlist ships the runtime surface and never test/', () => {
  const files = pkg.files ?? [];
  for (const entry of ['index.ts', 'lib/', 'skills/', 'prompts/', 'README.md']) {
    assert.ok(files.includes(entry), `files must include ${entry}`);
  }
  assert.ok(!files.some((f) => f.replace(/^\.\//, '').startsWith('test')), 'files must not include test/');
});

test('AC1: npm pack --dry-run ships the runtime surface and NO test files', () => {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: pkgDir,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(res.status, 0, `npm pack failed:\n${res.stderr}`);
  const manifest = JSON.parse(res.stdout);
  const paths = manifest[0].files.map((f) => f.path.replace(/^\.\//, ''));

  assert.ok(paths.includes('index.ts'), 'pack must include index.ts');
  assert.ok(paths.includes('README.md'), 'pack must include README.md');
  assert.ok(paths.some((p) => p.startsWith('lib/')), 'pack must include lib/');
  assert.ok(paths.some((p) => p.startsWith('skills/')), 'pack must include skills/');
  assert.ok(paths.some((p) => p.startsWith('prompts/')), 'pack must include prompts/');
  assert.ok(!paths.some((p) => p.startsWith('test/')), `pack must NOT include test/: ${paths.filter((p) => p.startsWith('test/')).join(', ')}`);
});

// --- AC3: ADLC_PI_BIN override on the deny proof --------------------------

test('AC3: pi-live-deny.mjs consults ADLC_PI_BIN before running pi', () => {
  const liveDeny = join(repoRoot, 'scripts', 'pi-live-deny.mjs');
  const bogus = join(tmpdir(), 'adlc-pi-nonexistent-binary-xyz');
  const res = spawnSync('node', [liveDeny], {
    cwd: repoRoot,
    env: { ...process.env, ADLC_PI_BIN: bogus },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;

  const [maj, min] = process.versions.node.split('.').map(Number);
  const piSupported = maj > 22 || (maj === 22 && min >= 19);

  if (piSupported) {
    // Precondition: the DEFAULT bin exists — so a "not found" can only come from
    // the bogus override having been consulted (not the default path).
    assert.ok(existsSync(join(repoRoot, 'node_modules', '.bin', 'pi')), 'precondition: default pi bin present');
    assert.equal(res.status, 1, `expected fast-fail; got ${res.status}\n${out}`);
    assert.match(out, /pi binary not found/, 'override path should be reported missing');
  } else {
    // pi is unsupported on this Node major; the proof hard-skips before the bin
    // check (CI exercises the override on the Node 22 leg).
    assert.equal(res.status, 0, out);
    assert.match(out, /SKIP:/);
  }
});

// --- AC3: version-matrix verdict table ------------------------------------

test('AC3: matrixVerdict — pinned deny proof skipped (old runtime) is a non-fatal SKIP', () => {
  const v = matrixVerdict({ pinnedSkipped: true });
  assert.equal(v.code, 0);
  assert.equal(v.level, 'SKIP');
});

test('AC3: matrixVerdict — latest uninstallable (offline) is a non-fatal SKIP', () => {
  const v = matrixVerdict({ latestInstallable: false, pinnedVersion: '0.80.3' });
  assert.equal(v.code, 0);
  assert.equal(v.level, 'SKIP');
});

test('AC3: matrixVerdict — latest == pinned and passes is CLEAN exit 0', () => {
  const v = matrixVerdict({ latestInstallable: true, latestPassed: true, pinnedVersion: '0.80.3', latestVersion: '0.80.3' });
  assert.equal(v.code, 0);
  assert.equal(v.level, 'CLEAN');
});

test('AC3: matrixVerdict — latest drifts but passes is a WARN exit 0', () => {
  const v = matrixVerdict({ latestInstallable: true, latestPassed: true, pinnedVersion: '0.80.3', latestVersion: '0.80.6' });
  assert.equal(v.code, 0);
  assert.equal(v.level, 'WARN');
  assert.match(v.message, /0\.80\.3/);
  assert.match(v.message, /0\.80\.6/);
});

test('AC3: matrixVerdict — latest FAILS the deny proof is the ONLY exit 1', () => {
  const v = matrixVerdict({ latestInstallable: true, latestPassed: false, pinnedVersion: '0.80.3', latestVersion: '0.80.6' });
  assert.equal(v.code, 1);
  assert.equal(v.level, 'FAIL');
});
